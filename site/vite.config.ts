import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { handle } from './server/handler.ts';

interface Item { slug: string; mark: string; kv: number; H: number | null; h: number | null; L: number | null; mass: number | null; project: string | null }

const fmt = (n: number | null) => (n == null ? '—' : String(n).replace('.', ','));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Bakes the catalog table into the HTML, so it is indexable and works without JS. */
function catalogTable(): Plugin {
  return {
    name: 'catalog-table',
    transformIndexHtml(html) {
      const items: Item[] = JSON.parse(readFileSync(new URL('./src/data/catalog.json', import.meta.url), 'utf8'));
      const rows = items
        .map(
          it =>
            `<tr data-slug="${it.slug}" data-kv="${it.kv}"><th scope="row"><a href="#/opora/${it.slug}">${esc(it.mark)}</a></th><td>${it.kv}</td><td>${fmt(it.H)}</td><td>${fmt(it.h)}</td><td>${fmt(it.L)}</td><td>${it.mass == null ? '—' : it.mass.toLocaleString('ru-RU')}</td><td>${esc(it.project ?? '—')}</td></tr>`,
        )
        .join('');
      return html.replace('<!--CATALOG_ROWS-->', rows);
    },
  };
}

/**
 * Serves the assistant endpoint (api/chat.ts, a Vercel Function in production) from the
 * dev and preview servers. ASSISTANT_FAKE=1 swaps the model for a scripted double so the
 * interface can be exercised without an API key; that path does not exist in the deployed function.
 */
function assistantApi(mode: string): Plugin {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const fake = env.ASSISTANT_FAKE === '1' ? import('./tests/fake-model.ts').then(m => m.demoClient().client) : null;
  const middleware: Connect.NextHandleFunction = async (req, res: ServerResponse, next) => {
    if (!req.url?.startsWith('/api/chat')) return next();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 200_000) {
          res.statusCode = 413;
          return void res.end();
        }
        chunks.push(c as Buffer);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body, signal: abort.signal });
      const client = await fake;
      const response = await handle(request, client ? { env: { ...env, ASSISTANT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'fake' }, createClient: () => client, limit: () => ({ ok: true, retryAfter: 0 }) } : { env });
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      if (!response.body) return void res.end();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      res.end();
    } catch {
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  };
  return {
    name: 'assistant-api',
    configureServer: server => void server.middlewares.use(middleware),
    configurePreviewServer: server => void server.middlewares.use(middleware),
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [catalogTable(), assistantApi(mode)],
  build: {
    target: 'es2020',
    assetsInlineLimit: 2048,
  },
  server: { host: true },
  // same security headers as production (vercel.json), so `npm run preview` catches CSP breakage
  preview: {
    headers: Object.fromEntries(
      (JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')).headers[0].headers as { key: string; value: string }[])
        .map(h => [h.key, h.key === 'Content-Security-Policy' ? h.value.replace('; upgrade-insecure-requests', '') : h.value]),
    ),
  },
}));
