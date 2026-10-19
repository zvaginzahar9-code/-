import { describe, expect, it } from 'vitest';
import { createGeminiClient, toGeminiSchema } from '../server/gemini';
import { handle } from '../server/handler';
import { readConfig } from '../server/http';
import { toolDefinitions } from '../server/tools';
import type { ServerEvent } from '../src/assistant/protocol';
import { parseEvents } from '../src/assistant/stream';

/**
 * These tests replay the event stream documented for the Interactions API against the adapter.
 * They check the adapter's own logic; they are not evidence that the real API accepts our requests —
 * that is what scripts/check_gemini.mjs is for.
 */

type Reply = object[] | Response | Error;
function fakeGemini(replies: Reply[]) {
  const requests: { url: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const reply = replies[Math.min(n++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    const sse = reply.map(e => `event: ${(e as { event_type: string }).event_type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
    const bytes = new TextEncoder().encode(sse);
    // split inside an event and inside a multi-byte character
    return new Response(new ReadableStream({ start: c => (c.enqueue(bytes.slice(0, 41)), c.enqueue(bytes.slice(41, 97)), c.enqueue(bytes.slice(97)), c.close()) }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}
const created = (id: string) => ({ event_type: 'interaction.created', interaction: { id, status: 'in_progress' } });
const completed = (id: string, status = 'completed') => ({ event_type: 'interaction.completed', interaction: { id, status, usage: { total_input_tokens: 900, total_output_tokens: 20 } } });
const answer = (id: string, ...parts: string[]) => [
  created(id),
  { event_type: 'step.start', index: 0, step: { type: 'thought' } },
  { event_type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'c2ln' } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
  ...parts.map(text => ({ event_type: 'step.delta', index: 1, delta: { type: 'text', text } })),
  { event_type: 'step.stop', index: 1 },
  completed(id),
];
const call = (id: string, callId: string, name: string, args: object) => [
  created(id),
  { event_type: 'step.start', index: 0, step: { type: 'function_call', id: callId, name } },
  { event_type: 'step.delta', index: 0, delta: { type: 'arguments', partial_arguments: JSON.stringify(args).slice(0, 9) } },
  { event_type: 'step.delta', index: 0, delta: { type: 'arguments', partial_arguments: JSON.stringify(args).slice(9) } },
  { event_type: 'step.stop', index: 0, status: 'waiting' },
  { event_type: 'interaction.status_update', interaction_id: id, status: 'requires_action' },
];

const ENV = { VERCEL: '1', GEMINI_API_KEY: 'AIza-test-key' };
async function chat(fetch: typeof globalThis.fetch, question = 'Найди опоры для ЛЭП 110 кВ', env: Record<string, string> = ENV, before: { role: string; content: string }[] = []) {
  const res = await handle(new Request('https://site/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [...before, { role: 'user', content: question }] }) }), {
    env,
    limit: () => ({ ok: true, retryAfter: 0 }),
    createClient: config => createGeminiClient({ apiKey: config.gemini.apiKey!, baseUrl: config.gemini.baseUrl, thinkingLevel: config.gemini.thinkingLevel, fetch }),
  });
  const events = res.ok ? parseEvents(await res.text()).events : [];
  return { res, events, text: events.flatMap(e => (e.t === 'text' ? [e.d] : [])).join(''), kinds: events.filter(e => e.t !== 'status' && e.t !== 'text').map(e => e.t) };
}

describe('provider selection', () => {
  it('uses Gemini on the published site when its key is set, and a local model in development', () => {
    expect(readConfig({ VERCEL: '1', GEMINI_API_KEY: 'k' })).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite', configured: true });
    expect(readConfig({ GEMINI_API_KEY: 'k' })).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', configured: true });
    expect(readConfig({})).toMatchObject({ provider: 'ollama', model: 'qwen3:8b' });
  });

  it('lets configuration override the choice either way', () => {
    expect(readConfig({ ASSISTANT_PROVIDER: 'gemini', GEMINI_API_KEY: 'k' })).toMatchObject({ provider: 'gemini', configured: true });
    expect(readConfig({ ASSISTANT_PROVIDER: 'gemini' })).toMatchObject({ provider: 'gemini', configured: false });
    expect(readConfig({ VERCEL: '1', GEMINI_API_KEY: 'k', ASSISTANT_PROVIDER: 'ollama' })).toMatchObject({ provider: 'ollama', configured: false });
    expect(readConfig({ VERCEL: '1', GEMINI_API_KEY: 'k', OLLAMA_BASE_URL: 'https://llm.example.com' })).toMatchObject({ provider: 'ollama', configured: true });
    expect(readConfig({ VERCEL: '1', GEMINI_API_KEY: 'k', ASSISTANT_MODEL: 'gemini-3.1-flash-lite' }).model).toBe('gemini-3.1-flash-lite');
    expect(readConfig({ VERCEL: '1' })).toMatchObject({ provider: 'ollama', configured: false });
  });

  it('reports the published site as not configured without a key, and never calls out', async () => {
    const { fetch, requests } = fakeGemini([answer('i1', 'x')]);
    const { res } = await chat(fetch, 'q', { VERCEL: '1', ASSISTANT_PROVIDER: 'gemini' });
    expect(res.status).toBe(503);
    expect(requests).toHaveLength(0);
  });
});

describe('a turn through Gemini', () => {
  it('streams text and sends the key only in the header', async () => {
    const { fetch, requests } = fakeGemini([answer('i1', 'Телефон: ', '+7 777 684 60 70.')]);
    const { text, kinds, events } = await chat(fetch, 'Какой у вас телефон?');
    expect(text).toBe('Телефон: +7 777 684 60 70.');
    expect(kinds).toEqual(['done']);
    const [r] = requests;
    expect(r.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse');
    expect(r.headers['x-goog-api-key']).toBe('AIza-test-key');
    expect(r.url + JSON.stringify(r.body) + JSON.stringify(events)).not.toContain('AIza-test-key');
    expect(r.body).toMatchObject({ model: 'gemini-3.5-flash-lite', stream: true, generation_config: { thinking_level: 'low' } });
    expect(r.body.system_instruction).toContain('Навигатор');
    expect(r.body.tools).toHaveLength(8);
    expect(r.body.tools[0]).toMatchObject({ type: 'function', name: 'search_catalog' });
    expect(r.body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'Какой у вас телефон?' }] }]);
  });

  it('runs the requested tool and continues the same interaction with its real result', async () => {
    const { fetch, requests } = fakeGemini([call('i1', 'fc_1', 'search_catalog', { voltage_kv: 110 }), answer('i2', 'Нашёл опоры ', '110 кВ.')]);
    const { text, kinds, events } = await chat(fetch);
    expect(kinds).toEqual(['products', 'done']);
    expect((events.find(e => e.t === 'products') as Extract<ServerEvent, { t: 'products' }>).items.every(i => i.kv === 110)).toBe(true);
    expect(text).toBe('Нашёл опоры 110 кВ.');
    const second = requests[1].body;
    expect(second.previous_interaction_id).toBe('i1');
    expect(second.input).toHaveLength(1);
    expect(second.input[0]).toMatchObject({ type: 'function_result', name: 'search_catalog', call_id: 'fc_1' });
    expect(second.input[0].result[0].text).toContain('1П110-6');
    expect(second.tools).toHaveLength(8);
    expect(second.system_instruction).toContain('Навигатор');
  });

  it('sends earlier turns as typed history', async () => {
    const { fetch, requests } = fakeGemini([answer('i1', 'Да.')]);
    await chat(fetch, 'А на 220?', ENV, [
      { role: 'user', content: 'Покажи опоры на 110 кВ' },
      { role: 'assistant', content: 'Вот они.' },
    ]);
    expect(requests[0].body.input.map((s: { type: string }) => s.type)).toEqual(['user_input', 'model_output', 'user_input']);
    expect(requests[0].body.previous_interaction_id).toBeUndefined();
  });

  it('tells the model when a tool failed', async () => {
    const { fetch, requests } = fakeGemini([call('i1', 'fc_9', 'open_tower_sheet', { mark: 'П999-9' }), answer('i2', 'Такой марки нет.')]);
    const { kinds } = await chat(fetch, 'Открой чертёж П999-9');
    expect(kinds).toEqual(['done']);
    expect(requests[1].body.input[0]).toMatchObject({ call_id: 'fc_9', is_error: true });
  });

  it('accepts arguments delivered whole and refuses ones that cannot be parsed', async () => {
    const whole = [created('i1'), { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'fc_1', name: 'get_tower_details', arguments: { mark: 'П110-2' } } }, { event_type: 'interaction.status_update', status: 'requires_action' }];
    expect((await chat(fakeGemini([whole, answer('i2', 'Вот.')]).fetch)).kinds).toEqual(['details', 'done']);
    const broken = [created('i1'), { event_type: 'step.start', index: 0, step: { type: 'function_call', id: 'fc_1', name: 'search_catalog' } }, { event_type: 'step.delta', index: 0, delta: { type: 'arguments', partial_arguments: '{"voltage_kv":1' } }, { event_type: 'interaction.status_update', status: 'requires_action' }];
    const r = await chat(fakeGemini([broken, answer('i2', 'Уточните.')]).fetch);
    expect(r.kinds).toEqual(['done']); // no unfiltered cards
  });

  it('reports a cut-off answer and a blocked one for what they are', async () => {
    const cut = [...answer('i1', 'Начало').slice(0, -1), completed('i1', 'incomplete')];
    expect((await chat(fakeGemini([cut]).fetch)).events.at(-1)).toEqual({ t: 'done', stop: 'max_tokens' });
    const blocked = [created('i1'), { event_type: 'error', error: { code: 'safety', message: 'blocked' } }];
    expect((await chat(fakeGemini([blocked]).fetch)).events.at(-1)).toEqual({ t: 'done', stop: 'refusal' });
  });
});

describe('errors and limits of the API', () => {
  const body = (code: string, status: number) => new Response(JSON.stringify({ error: { code, message: `detail with key AIza-secret and ${code}` } }), { status });
  const cases: [string, Reply, string][] = [
    ['an invalid key', body('authentication', 401), 'not_configured'],
    ['a key without access', body('permission_denied', 403), 'not_configured'],
    ['a model that does not exist', body('model_not_found', 404), 'not_configured'],
    ['the per-minute limit', body('rate_limit_exceeded', 429), 'rate_limited'],
    ['the daily quota', body('quota_exceeded', 429), 'rate_limited'],
    ['an overloaded service', body('service_unavailable', 503), 'unavailable'],
    ['a server error', body('api_error', 500), 'provider'],
    ['a bad request', body('invalid_request', 400), 'provider'],
    ['a deadline', body('deadline_exceeded', 504), 'timeout'],
    ['no network', new TypeError('fetch failed'), 'unavailable'],
    ['an error event mid-stream', [created('i1'), { event_type: 'error', error: { code: 'api_error', message: 'boom AIza-secret' } }], 'provider'],
    ['a limit hit mid-stream', [created('i1'), { event_type: 'error', error: { code: 'rate_limit_exceeded' } }], 'rate_limited'],
    ['a stream that just stops', [created('i1'), { event_type: 'step.start', index: 0, step: { type: 'model_output' } }], 'provider'],
    ['a failed interaction', [created('i1'), completed('i1', 'failed')], 'provider'],
  ];
  it.each(cases)('%s → a safe error event', async (_name, reply, code) => {
    const { events } = await chat(fakeGemini([reply]).fetch);
    expect(events.at(-1)).toMatchObject({ t: 'error', code });
    expect(events.some(e => e.t === 'done')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/AIza|detail with key|boom/);
  });

  it('times out and can be cancelled', async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const client = createGeminiClient({ apiKey: 'k', baseUrl: 'https://g', thinkingLevel: 'low', fetch: hang });
    await expect(client.messages.stream({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }, { timeout: 30 }).finalMessage()).rejects.toMatchObject({ name: 'ProviderError', code: 'timeout' });
    const abort = new AbortController();
    const pending = client.messages.stream({ model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }, { signal: abort.signal, timeout: 5000 }).finalMessage();
    setTimeout(() => abort.abort(), 20);
    expect((await pending.catch(e => e)).name).not.toBe('ProviderError');
  });
});

describe('tool schemas for Gemini', () => {
  it('turns nullable arguments into optional ones and drops what the dialect lacks', () => {
    const search = toGeminiSchema(toolDefinitions[0].input_schema) as { properties: Record<string, { type: unknown; enum?: unknown[] }>; required: string[]; additionalProperties?: unknown };
    expect(search.properties.voltage_kv).toMatchObject({ type: 'integer', enum: [35, 110, 220, 330, 500] });
    expect(search.properties.query.type).toBe('string');
    expect(search.required).toEqual([]);
    expect('additionalProperties' in search).toBe(false);
    const details = toGeminiSchema(toolDefinitions[1].input_schema) as { required: string[] };
    expect(details.required).toEqual(['mark']);
    // no type unions, no null among allowed values, no closed-object keyword anywhere
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const o = node as Record<string, unknown>;
      expect(Array.isArray(o.type)).toBe(false);
      if (Array.isArray(o.enum)) expect(o.enum).not.toContain(null);
      expect('additionalProperties' in o).toBe(false);
      Object.values(o).forEach(walk);
    };
    toolDefinitions.forEach(t => walk(toGeminiSchema(t.input_schema)));
  });
});
