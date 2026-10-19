// A small guard in front of a local Ollama, for the day the published site has to reach
// models that run on your own machine. Ollama itself has no authentication, so it must never
// be exposed directly (keep its port 11434 on loopback). This gateway:
//   - listens on 127.0.0.1 only (put a tunnel such as Cloudflare Tunnel in front of it,
//     pointed at this port; do not forward a router port to it);
//   - requires a bearer token on every request and slows down repeated wrong guesses;
//   - passes through only what the assistant needs: POST /api/chat and POST /api/show,
//     only for the models you allow, and only the request fields the assistant uses —
//     everything else a caller sends is discarded, and sizes are capped;
//   - limits request size and the number of answers generated at once.
//
//   OLLAMA_GATEWAY_TOKEN=<64 random hex characters> node scripts/ollama_gateway.mjs
//   (generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
//
// Then, on the site's server: OLLAMA_BASE_URL=<public https address of the tunnel>,
// OLLAMA_API_KEY=<the same token>.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const TOKEN = process.env.OLLAMA_GATEWAY_TOKEN ?? '';
const PORT = Number(process.env.OLLAMA_GATEWAY_PORT ?? 11500);
const UPSTREAM = (process.env.OLLAMA_UPSTREAM ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODELS = new Set((process.env.OLLAMA_GATEWAY_MODELS ?? 'qwen3:8b,mistral:latest').split(',').map(s => s.trim()).filter(Boolean));
const MAX_BODY = 512 * 1024;
const MAX_ACTIVE = Number(process.env.OLLAMA_GATEWAY_CONCURRENCY ?? 2);
const MAX_CTX = 16384;
const MAX_PREDICT = 1024;

if (TOKEN.length < 32) {
  console.error('OLLAMA_GATEWAY_TOKEN must be a random string of at least 32 characters.');
  process.exit(1);
}
const digest = s => createHash('sha256').update(s).digest();
const expected = digest(`Bearer ${TOKEN}`);
const authorised = header => typeof header === 'string' && timingSafeEqual(digest(header), expected);

let active = 0;
let failures = 0; // wrong tokens in the current minute
setInterval(() => (failures = 0), 60_000).unref();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const send = (res, status, message) => {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
};
const num = (v, min, max, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

/** Rebuilds the request from the fields the assistant uses; anything else is dropped. */
function cleanChat(body) {
  const o = body.options && typeof body.options === 'object' ? body.options : {};
  return {
    model: body.model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    ...(body.format && typeof body.format === 'object' ? { format: body.format } : {}),
    ...(typeof body.think === 'boolean' ? { think: body.think } : {}),
    stream: true,
    keep_alive: '30m',
    options: { temperature: num(o.temperature, 0, 1, 0.2), num_ctx: num(o.num_ctx, 2048, MAX_CTX, 8192), num_predict: num(o.num_predict, 16, MAX_PREDICT, MAX_PREDICT) },
  };
}

async function handle(req, res) {
  if (!authorised(req.headers.authorization)) {
    failures++;
    await sleep(Math.min(5000, 250 * failures)); // guessing gets slower with every miss
    return send(res, 401, 'unauthorised');
  }
  const path = (req.url ?? '').split('?')[0];
  if (req.method !== 'POST' || (path !== '/api/chat' && path !== '/api/show')) return send(res, 404, 'not found');

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      req.destroy();
      return send(res, 413, 'request too large');
    }
    chunks.push(c);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, 'bad request');
  }
  if (!body || typeof body.model !== 'string' || !MODELS.has(body.model)) return send(res, 403, 'model not allowed');

  if (path === '/api/show') {
    // the assistant only needs to know what the model can do; the Modelfile stays private
    const upstream = await fetch(`${UPSTREAM}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: body.model }), signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) return send(res, upstream.status === 404 ? 404 : 502, 'model server error');
    const info = await upstream.json();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return void res.end(JSON.stringify({ capabilities: Array.isArray(info.capabilities) ? info.capabilities : [] }));
  }

  if (active >= MAX_ACTIVE) return send(res, 503, 'busy');
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // the caller went away: stop the model
  active++;
  try {
    const upstream = await fetch(`${UPSTREAM}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cleanChat(body)), signal: abort.signal });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } finally {
    active--;
  }
}

const server = createServer((req, res) => {
  req.on('error', () => {}); // a caller that drops mid-request must not take the gateway down
  res.on('error', () => {});
  handle(req, res).catch(() => send(res, 502, 'model server unavailable'));
});
process.on('unhandledRejection', () => {});

server.listen(PORT, '127.0.0.1', () => console.log(`Ollama gateway on http://127.0.0.1:${PORT} → ${UPSTREAM}; models: ${[...MODELS].join(', ')}`));
