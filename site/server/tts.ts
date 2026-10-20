import { clientKey, createRateLimiter, errorResponse, originAllowed, readConfig } from './http.ts';

/**
 * POST /api/tts {text} — the assistant's answer read aloud by a neural voice (Gemini TTS).
 * The audio streams back as raw 16-bit PCM, mono, 24 kHz, while it is being generated, so the
 * page starts playing before the whole phrase is synthesised. The key stays on the server.
 * When the voice is unavailable (no key, quota, outage) the page falls back to the browser voice.
 *
 * Request format: Interactions API with `response_format: {type: "audio"}` and a
 * `speech_metadata` annotation for the delivery style (ai.google.dev/gemini-api/docs/speech-generation).
 */

const MAX_CHARS = 900;
const perMinute = createRateLimiter(30, 60_000);
const perHour = createRateLimiter(240, 3_600_000);
export const SAMPLE_RATE = 24_000;

export interface TtsDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  limit?: (key: string) => { ok: boolean; retryAfter: number };
}

const runtimeEnv = () => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * The voice and its manner: a lively, warm consultant rather than a reader of letters.
 * Each TTS model has its own free-tier quota, so when one answers 429 the next is tried
 * (GEMINI_TTS_MODEL may list several, comma-separated).
 */
export function ttsSettings(env: Record<string, string | undefined>) {
  const models = (env.GEMINI_TTS_MODEL?.trim() || 'gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts,gemini-3.1-flash-tts-preview')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return {
    model: models[0],
    models,
    voice: env.GEMINI_TTS_VOICE?.trim() || 'Puck',
    style: env.GEMINI_TTS_STYLE?.trim() || 'warm, lively and friendly, like an engaged consultant talking to a client; natural conversational pace with expressive intonation',
  };
}

/**
 * Text as it should be heard: abbreviations a speech model mispronounces or spells out with a
 * foreign accent are written the way a Russian speaker says them; list dashes and quotes go.
 */
export function speakable(text: string): string {
  // `\b` does not see Cyrillic letters: word edges are spelled out with Unicode classes
  const word = (w: string, unitAfterDigit = false) => new RegExp(`${unitAfterDigit ? '(?<=\\d\\s?)' : '(?<![\\p{L}\\d])'}${w}(?![\\p{L}\\d])`, 'gu');
  const words: [RegExp, string][] = [
    [word('кВ', true), ' киловольт'],
    [word('кВ'), 'киловольт'],
    [word('МВт', true), ' мегаватт'],
    [word('ШГЭС'), 'Шульбинская гэс'],
    [word('ВЛ'), 'вэ-эл'],
    [word('ТОО'), 'тэ-о-о'],
    [word('ООО'), 'о-о-о'],
    [word('ОРУ'), 'о-эр-у'],
    [word('ПС'), 'подстанция'],
    [word('КМД'), 'кэ-эм-дэ'],
    [word('КЗГЦ'), 'кэ-зэ-гэ-цэ'],
    [word('ЭК'), 'э-ка'],
    [word('ЭМК'), 'э-эм-ка'],
    [word('ГЭС'), 'гэс'],
    [word('ВЭС'), 'вэс'],
    [word('ВКО'), 'Восточно-Казахстанская область'],
    [word('РК'), 'Республики Казахстан'],
    [word('БИН'), 'бин'],
  ];
  let t = text.replace(/[«»"“”]/g, '').replace(/^\s*[-•*]\s+/gm, '').replace(/\s+[—–]\s+/g, ', ');
  for (const [re, to] of words) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function handleTts(request: Request, deps: TtsDeps = {}): Promise<Response> {
  const env = deps.env ?? runtimeEnv();
  const config = readConfig(env);
  const apiKey = config.gemini.apiKey;
  if (request.method === 'GET') return Response.json({ configured: !!apiKey }, { headers: { 'Cache-Control': 'no-store' } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  if (!originAllowed(request)) return errorResponse('forbidden');
  if (!request.headers.get('content-type')?.trim().toLowerCase().startsWith('application/json')) return errorResponse('bad_request');
  if (Number(request.headers.get('content-length') ?? 0) > 8_000) return errorResponse('bad_request');

  const key = clientKey(request);
  const gate = deps.limit ? deps.limit(key) : [perMinute(key), perHour(key)].find(r => !r.ok) ?? { ok: true, retryAfter: 0 };
  if (!gate.ok) return errorResponse('rate_limited', { 'Retry-After': String(gate.retryAfter) });

  let text = '';
  try {
    const body = JSON.parse(await request.text()) as { text?: unknown };
    text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  } catch {
    return errorResponse('bad_request');
  }
  if (!text || text.length > MAX_CHARS) return errorResponse('bad_request');
  if (!apiKey) return errorResponse('not_configured');

  const { models, voice, style } = ttsSettings(env);
  const spoken = speakable(text);
  const doFetch = deps.fetch ?? fetch;
  const upstream = new AbortController();
  request.signal?.addEventListener('abort', () => upstream.abort(), { once: true });
  const timer = setTimeout(() => upstream.abort(), 30_000);
  let res!: Response;
  let model = models[0];
  // a model whose free quota is used up (429) hands over to the next one
  for (model of models) {
    try {
      res = await doFetch(`${config.gemini.baseUrl.replace(/\/+$/, '')}/v1beta/interactions?alt=sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          model,
          input: [{ type: 'user_input', content: [{ type: 'text', text: spoken, annotations: [{ type: 'speech_metadata', style }] }] }],
          response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: SAMPLE_RATE },
          generation_config: { speech_config: [{ voice }] },
          stream: true,
        }),
        signal: upstream.signal,
        redirect: 'error',
      });
    } catch {
      clearTimeout(timer);
      return errorResponse('unavailable');
    }
    if (res.status !== 429 && res.status !== 404) break;
    console.error(JSON.stringify({ evt: 'tts_fallback', status: res.status, model }));
    await res.body?.cancel().catch(() => {});
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    console.error(JSON.stringify({ evt: 'tts_error', status: res.status, model }));
    return errorResponse(res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'not_configured' : 'unavailable');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  let bytes = 0;
  // the events carry base64 PCM in `step.delta` with `delta.type === "audio"`; only the bytes go to the page
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      let odd: number | null = null; // a 16-bit sample split across two chunks
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
            if (!data || data === '[DONE]') continue;
            let e: { event_type?: string; delta?: { type?: string; data?: string } };
            try {
              e = JSON.parse(data);
            } catch {
              continue;
            }
            if (e.event_type === 'step.delta' && e.delta?.type === 'audio' && e.delta.data) {
              let chunk = base64ToBytes(e.delta.data);
              if (odd !== null) {
                const joined = new Uint8Array(chunk.length + 1);
                joined[0] = odd;
                joined.set(chunk, 1);
                chunk = joined;
                odd = null;
              }
              if (chunk.length % 2) {
                odd = chunk[chunk.length - 1];
                chunk = chunk.subarray(0, chunk.length - 1);
              }
              bytes += chunk.length;
              controller.enqueue(chunk);
            }
          }
        }
      } catch {
        /* the page stopped listening or the upstream broke: end what was sent */
      } finally {
        clearTimeout(timer);
        console.log(JSON.stringify({ evt: 'tts', model, voice, chars: text.length, seconds: +(bytes / 2 / SAMPLE_RATE).toFixed(1), ms: Date.now() - started }));
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      upstream.abort();
    },
  });
  return new Response(body, { headers: { 'Content-Type': `audio/L16; rate=${SAMPLE_RATE}; channels=1`, 'Cache-Control': 'no-store', 'X-Sample-Rate': String(SAMPLE_RATE) } });
}
