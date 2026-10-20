import { describe, expect, it } from 'vitest';
import { handleTts, ttsSettings } from '../server/tts';

/** Replays the documented TTS event stream (step.delta with base64 audio) against the endpoint. */
function fakeTts(reply: Response | ((body: any) => string)) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body, headers: init.headers as Record<string, string> });
    if (reply instanceof Response) return reply;
    return new Response(reply(body));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const sse = (...chunks: number[][]) =>
  [{ event_type: 'interaction.created', interaction: { id: 'i1' } }, ...chunks.map(c => ({ event_type: 'step.delta', index: 0, delta: { type: 'audio', data: b64(c) } })), { event_type: 'interaction.completed' }]
    .map(e => `event: ${e.event_type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
const ENV = { VERCEL: '1', GEMINI_API_KEY: 'AIza-test-key' };
const req = (text: unknown, headers: Record<string, string> = {}) =>
  new Request('https://site/api/tts', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text }) });
const open = () => ({ ok: true, retryAfter: 0 });

describe('neural voice endpoint', () => {
  it('asks Gemini TTS for streamed audio with the voice and style, key only in the header', async () => {
    const { fetch, calls } = fakeTts(() => sse([1, 0, 2, 0]));
    const res = await handleTts(req('Нашёл опору П110-2.'), { env: ENV, fetch, limit: open });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/L16');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 0, 2, 0]));
    const [c] = calls;
    expect(c.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse');
    expect(c.headers['x-goog-api-key']).toBe('AIza-test-key');
    expect(JSON.stringify(c.body)).not.toContain('AIza-test-key');
    expect(c.body).toMatchObject({ model: 'gemini-3.8-flash-lite-tts', stream: true, response_format: { type: 'audio', mime_type: 'audio/l16', sample_rate: 24000 }, generation_config: { speech_config: [{ voice: 'Puck' }] } });
    expect(c.body.input[0].content[0]).toMatchObject({ type: 'text', text: 'Нашёл опору П110-2.', annotations: [{ type: 'speech_metadata' }] });
    expect(c.body.input[0].content[0].annotations[0].style).toMatch(/warm|lively/);
  });

  it('keeps 16-bit samples whole when a chunk ends mid-sample', async () => {
    const { fetch } = fakeTts(() => sse([1, 0, 2], [0, 3, 0]));
    const res = await handleTts(req('Да.'), { env: ENV, fetch, limit: open });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 0, 2, 0, 3, 0]));
  });

  it('voice, model and style can be changed without code', () => {
    expect(ttsSettings({ GEMINI_TTS_VOICE: 'Achird', GEMINI_TTS_MODEL: 'gemini-3.8-flash-tts', GEMINI_TTS_STYLE: 'calm' })).toEqual({ voice: 'Achird', model: 'gemini-3.8-flash-tts', style: 'calm' });
  });

  it('reports errors so the page can fall back to the browser voice', async () => {
    expect((await handleTts(req('Да.'), { env: {}, limit: open })).status).toBe(503); // no key
    expect((await handleTts(req('Да.'), { env: ENV, fetch: fakeTts(new Response('{}', { status: 429 })).fetch, limit: open })).status).toBe(429);
    expect((await handleTts(req(''), { env: ENV, limit: open })).status).toBe(400);
    expect((await handleTts(req('а'.repeat(901)), { env: ENV, limit: open })).status).toBe(400);
    expect((await handleTts(req('Да.', { origin: 'https://evil.example' }), { env: ENV, limit: open })).status).toBe(403);
    expect((await handleTts(req('Да.'), { env: ENV, limit: () => ({ ok: false, retryAfter: 9 }) })).status).toBe(429);
  });
});
