import { describe, expect, it } from 'vitest';
import { handle } from '../server/handler';
import { readConfig, trimHistory } from '../server/http';
import { ProviderError, createLineFilter, createOllamaClient, parseTextToolCalls, routerSchema, type OllamaOptions } from '../server/ollama';
import { toolDefinitions } from '../server/tools';
import type { ServerEvent } from '../src/assistant/protocol';
import { parseEvents } from '../src/assistant/stream';

/** A stand-in for the Ollama HTTP API: answers /api/show and replays scripted /api/chat replies. */
function fakeOllama(replies: (object[] | Response | Error)[], capabilities = ['completion', 'tools']) {
  const requests: { url: string; body: Record<string, any>; headers: Record<string, string> }[] = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities });
    requests.push({ url: String(url), body, headers: init.headers as Record<string, string> });
    const reply = replies[Math.min(n++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    const lines = reply.map(c => JSON.stringify(c)).join('\n') + '\n';
    // split mid-line and mid-character to exercise the stream reader
    const bytes = new TextEncoder().encode(lines);
    return new Response(new ReadableStream({ start: c => (c.enqueue(bytes.slice(0, 7)), c.enqueue(bytes.slice(7, 31)), c.enqueue(bytes.slice(31)), c.close()) }));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}
const text = (...parts: string[]) => [...parts.map(p => ({ message: { content: p } })), { done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 9 }];
const call = (name: string, args: object) => [{ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } }, { done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 9 }];
const options = (o: Partial<OllamaOptions> & { fetch: typeof fetch }): OllamaOptions => ({ baseUrl: 'http://127.0.0.1:11434', apiKey: null, numCtx: 8192, keepAlive: '30m', think: false, toolMode: 'native', ...o });

const ENV = { ASSISTANT_PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
async function chat(env: Record<string, string>, fetch: typeof globalThis.fetch, question = 'Найди опоры для ЛЭП 110 кВ', toolMode?: 'native' | 'json') {
  const res = await handle(new Request('http://x/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: question }] }) }), {
    env,
    limit: () => ({ ok: true, retryAfter: 0 }),
    createClient: config => createOllamaClient(options({ fetch, baseUrl: config.ollama.baseUrl!, apiKey: config.ollama.apiKey, toolMode: toolMode ?? config.ollama.toolMode })),
  });
  const events = res.ok ? parseEvents(await res.text()).events : [];
  return { res, events, text: events.flatMap(e => (e.t === 'text' ? [e.d] : [])).join('') };
}
const kinds = (events: ServerEvent[]) => events.filter(e => e.t !== 'status' && e.t !== 'text').map(e => e.t);

describe('configuration', () => {
  it('uses a local model by default and needs no Anthropic key', () => {
    const c = readConfig({});
    expect(c).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', configured: true, apiKey: null });
    expect(c.ollama).toMatchObject({ baseUrl: 'http://127.0.0.1:11434', toolMode: 'native', numCtx: 8192 });
  });

  it('switches the model by ASSISTANT_MODEL and picks the tool protocol that was verified for it', () => {
    expect(readConfig({ ASSISTANT_MODEL: 'mistral:latest' })).toMatchObject({ model: 'mistral:latest', ollama: { toolMode: 'json' } });
    expect(readConfig({ ASSISTANT_MODEL: 'qwen3:8b' }).ollama.toolMode).toBe('native');
    expect(readConfig({ ASSISTANT_MODEL: 'mistral:latest', ASSISTANT_TOOL_MODE: 'native' }).ollama.toolMode).toBe('native');
  });

  it('never assumes the laptop address on a hosting platform', () => {
    expect(readConfig({ VERCEL: '1' })).toMatchObject({ provider: 'ollama', configured: false, ollama: { baseUrl: null } });
    expect(readConfig({ VERCEL: '1', OLLAMA_BASE_URL: 'https://llm.example.com', OLLAMA_API_KEY: 's3cret' })).toMatchObject({ configured: true, ollama: { baseUrl: 'https://llm.example.com', apiKey: 's3cret' } });
  });

  it('keeps the hosted provider available by name only', () => {
    expect(readConfig({ ASSISTANT_PROVIDER: 'anthropic' })).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5', configured: false });
    expect(readConfig({ ASSISTANT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).configured).toBe(true);
    expect(readConfig({ ANTHROPIC_API_KEY: 'k' }).provider).toBe('ollama');
  });

  it('answers 503 on a hosting platform without a gateway address', async () => {
    const res = await handle(new Request('http://x/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }) }), { env: { VERCEL: '1' }, limit: () => ({ ok: true, retryAfter: 0 }) });
    expect(res.status).toBe(503);
  });

  it('trims old turns to the context budget but keeps the current question', () => {
    const turns = [
      { role: 'user' as const, content: 'а'.repeat(3000) },
      { role: 'assistant' as const, content: 'б'.repeat(3000) },
      { role: 'user' as const, content: 'в'.repeat(1000) },
      { role: 'assistant' as const, content: 'г'.repeat(1000) },
      { role: 'user' as const, content: 'вопрос' },
    ];
    const kept = trimHistory(turns, 2500);
    expect(kept.map(t => t.content[0])).toEqual(['в', 'г', 'в']);
    expect(trimHistory(turns, 10)).toEqual([turns[4]]);
    expect(trimHistory(turns, 99999)).toHaveLength(5);
  });
});

describe('native tool calling', () => {
  it('runs the tool the model asked for and answers from the real result', async () => {
    const { fetch, requests } = fakeOllama([call('search_catalog', { voltage_kv: 110 }), text('Нашёл ', 'опоры ', '110 кВ.')]);
    const { events, text: answer } = await chat(ENV, fetch);
    expect(kinds(events)).toEqual(['products', 'done']);
    expect((events.find(e => e.t === 'products') as Extract<ServerEvent, { t: 'products' }>).items.every(i => i.kv === 110)).toBe(true);
    expect(answer).toBe('Нашёл опоры 110 кВ.');
    // request shape
    expect(requests[0].body).toMatchObject({ model: 'qwen3:8b', stream: true, options: { num_ctx: 8192 } });
    expect(requests[0].body.tools).toHaveLength(8);
    expect(requests[0].body.messages[0].role).toBe('system');
    // the tool result went back to the model with real catalogue data
    const back = requests[1].body.messages.slice(-2);
    expect(back[0]).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: 'search_catalog' } }] });
    expect(back[1]).toMatchObject({ role: 'tool', tool_name: 'search_catalog' });
    expect(back[1].content).toContain('1П110-6');
  });

  it('accepts a tool call written as text and never shows that JSON to the visitor', async () => {
    const { fetch } = fakeOllama([text('{"name": "get_tower_', 'details", "arguments": {"mark": "П110-2"}}'), text('Вот характеристики.')]);
    const { events, text: answer } = await chat(ENV, fetch);
    expect(kinds(events)).toEqual(['details', 'done']);
    expect(answer).toBe('Вот характеристики.');
  });

  it('refuses a call to a tool that does not exist and tells the model so', async () => {
    const { fetch, requests } = fakeOllama([call('delete_catalog', {}), text('Такого действия у меня нет.')]);
    const { events } = await chat(ENV, fetch);
    expect(kinds(events)).toEqual(['done']);
    expect(requests[1].body.messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'delete_catalog' });
    expect(requests[1].body.messages.at(-1).content).toContain('Такого инструмента нет');
  });

  it('does not run a tool whose arguments could not be parsed', async () => {
    const broken = [{ message: { content: '', tool_calls: [{ function: { name: 'search_catalog', arguments: '{"voltage_kv":110' } }] } }, { done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 9 }];
    const { fetch, requests } = fakeOllama([broken, text('Уточните запрос.')]);
    const { events } = await chat(ENV, fetch);
    expect(kinds(events)).toEqual(['done']); // no unfiltered cards presented as the answer
    expect(requests[1].body.messages.at(-1).content).toContain('error');
  });

  it('reports a prompt that overflowed the context window instead of answering without its rules', async () => {
    const full = [{ message: { content: 'Ответ без правил.' } }, { done: true, done_reason: 'stop', prompt_eval_count: 8192, eval_count: 5 }];
    const { fetch } = fakeOllama([full]);
    const { events } = await chat(ENV, fetch);
    expect(events.at(-1)).toMatchObject({ t: 'error', code: 'provider' });
    expect(events.map(e => e.t)).toContain('retract');
  });

  it('hides reasoning the model prints in <think> tags', async () => {
    const { fetch } = fakeOllama([text('<think>пользователь ', 'хочет опоры</think>', 'Уточните класс ', 'напряжения.')]);
    expect((await chat(ENV, fetch)).text).toBe('Уточните класс напряжения.');
  });

  it('sends the think switch only to models that have it', async () => {
    const plain = fakeOllama([text('ок')], ['completion', 'tools']);
    await chat(ENV, plain.fetch);
    expect('think' in plain.requests[0].body).toBe(false);
    const reasoning = fakeOllama([text('ок')], ['completion', 'tools', 'thinking']);
    await chat(ENV, reasoning.fetch);
    expect(reasoning.requests[0].body.think).toBe(false);
  });
});

describe('routed JSON protocol (models without reliable tool calling)', () => {
  const env = { ...ENV, ASSISTANT_MODEL: 'mistral:latest' };

  it('routes with a constrained reply, runs the tool, then writes the answer from its result', async () => {
    const { fetch, requests } = fakeOllama([text('{"tool":"search_catalog","arguments":{"query":null,"voltage_kv":220}}'), text('В каталоге ', 'есть опоры 220 кВ.')]);
    const { events, text: answer } = await chat(env, fetch, 'опоры 220');
    expect(kinds(events)).toEqual(['products', 'done']);
    expect(answer).toBe('В каталоге есть опоры 220 кВ.');
    // step 1: short routing prompt, schema-constrained, no native tools
    expect(requests[0].body.format.anyOf).toHaveLength(9);
    expect(requests[0].body.tools).toBeUndefined();
    expect(requests[0].body.messages[0].content).toContain('диспетчер');
    // step 2: written from the tool result, with no second routing after a successful call
    expect(requests).toHaveLength(2);
    expect(requests[1].body.format).toBeUndefined();
    expect(requests[1].body.messages[0].content).not.toContain('1У220-1');
    expect(requests[1].body.messages.at(-1).role).toBe('user');
    expect(requests[1].body.messages.at(-1).content).toMatch(/^опоры 220\n\n———\nРЕЗУЛЬТАТ ИНСТРУМЕНТА search_catalog/);
    expect(requests[1].body.messages.at(-1).content).toContain('1У220-1');
  });

  it('answers directly when routing says no tool is needed', async () => {
    const { fetch, requests } = fakeOllama([text('{"tool":"answer"}'), text('Горячее цинкование.')]);
    const { events, text: answer } = await chat(env, fetch, 'Как защищаете от коррозии?');
    expect(kinds(events)).toEqual(['done']);
    expect(answer).toBe('Горячее цинкование.');
    expect(requests).toHaveLength(2);
  });

  it('lets a failed call be corrected once, then must answer', async () => {
    const wrong = text('{"tool":"get_tower_details","arguments":{"mark":"П999-9"}}');
    const { fetch, requests } = fakeOllama([wrong, text('{"tool":"get_tower_details","arguments":{"mark":"П999-8"}}'), text('Такой марки в каталоге нет.')]);
    const { events, text: answer } = await chat(env, fetch, 'характеристики П999-9');
    expect(kinds(events)).toEqual(['done']);
    expect(answer).toBe('Такой марки в каталоге нет.');
    expect(requests.map(r => Boolean(r.body.format))).toEqual([true, true, false]);
  });

  it('fails cleanly when the routing reply is not JSON', async () => {
    const { fetch } = fakeOllama([text('я подумаю')]);
    const { events } = await chat(env, fetch);
    expect(events.at(-1)).toMatchObject({ t: 'error', code: 'provider' });
  });

  it('constrains the reply to declared tools with their own argument schemas', () => {
    const schema = routerSchema(toolDefinitions);
    expect(schema.anyOf.map(v => (v.properties.tool as { const: string }).const)).toEqual([...toolDefinitions.map(t => t.name), 'answer']);
    expect((schema.anyOf[0].properties as { arguments: unknown }).arguments).toBe(toolDefinitions[0].input_schema);
  });
});

describe('output hygiene', () => {
  const run = (...chunks: string[]) => {
    let out = '';
    const f = createLineFilter(t => (out += t));
    chunks.forEach(c => f.push(c));
    f.end();
    return out;
  };

  it('drops interface-style notes a model imitates, wherever the stream is cut', () => {
    expect(run('[Показаны карточки: П110-1, П110-2]\nВот ', 'две опоры.')).toBe('Вот две опоры.');
    expect(run('Открываю.\n[Дей', 'ствие: открыт лист]\n', 'Готово.')).toBe('Открываю.\nГотово.');
    expect(run('Действие: open_comparison\nСравниваю.')).toBe('Сравниваю.');
    expect(run('Текст\n[Действие: заявка отправлена]')).toBe('Текст\n');
  });

  it('leaves ordinary text and inline brackets alone', () => {
    expect(run('Масса [с цинком] — 4131 кг.\n- пункт')).toBe('Масса [с цинком] — 4131 кг.\n- пункт');
    expect(run('Д', 'ействительно, ', 'так.')).toBe('Действительно, так.');
    expect(run('[1] первый вариант подходит')).toBe('[1] первый вариант подходит');
  });

  it('recognises text tool calls only for declared tools', () => {
    const known = new Set(['search_catalog']);
    expect(parseTextToolCalls('[TOOL_CALLS] [{"name":"search_catalog","arguments":{"voltage_kv":110}}]', known)).toEqual([{ name: 'search_catalog', input: { voltage_kv: 110 } }]);
    expect(parseTextToolCalls('```json\n{"name":"search_catalog","arguments":"{\\"voltage_kv\\":35}"}\n```', known)).toEqual([{ name: 'search_catalog', input: { voltage_kv: 35 } }]);
    expect(parseTextToolCalls('{"name":"run_shell","arguments":{}}', known)).toBeNull();
    expect(parseTextToolCalls('Обычный ответ {не json}', known)).toBeNull();
  });
});

describe('failures of the model server', () => {
  const cases: [string, object[] | Response | Error, string][] = [
    ['Ollama not running', new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:11434'), 'unavailable'],
    ['model not installed', new Response('{"error":"model \\"qwen3:8b\\" not found"}', { status: 404 }), 'not_configured'],
    ['gateway rejecting the token', new Response('no', { status: 401 }), 'not_configured'],
    ['server overloaded', new Response('busy', { status: 503 }), 'rate_limited'],
    ['server error', new Response('boom', { status: 500 }), 'provider'],
    ['an error chunk mid-stream', [{ message: { content: 'Нач' } }, { error: 'CUDA out of memory at 0xdeadbeef' }], 'provider'],
    ['a stream cut before the end', [{ message: { content: 'Начало ответа' } }], 'provider'],
  ];
  it.each(cases)('%s → a safe error event', async (_name, reply, code) => {
    const { fetch } = fakeOllama([reply]);
    const { events } = await chat(ENV, fetch);
    expect(events.at(-1)).toMatchObject({ t: 'error', code });
    expect(events.some(e => e.t === 'done')).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|CUDA|deadbeef|not found/);
  });

  it('times out a model that never answers', async () => {
    const hang = ((url: string, init: RequestInit) => (String(url).endsWith('/api/show') ? Promise.resolve(Response.json({ capabilities: [] })) : new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))) as unknown as typeof fetch;
    const client = createOllamaClient(options({ fetch: hang }));
    const pending = client.messages.stream({ model: 'qwen3:8b', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }, { timeout: 30 }).finalMessage();
    await expect(pending).rejects.toMatchObject({ name: 'ProviderError', code: 'timeout' });
  });

  it('stops generation when the visitor cancels, without reporting an error', async () => {
    const abort = new AbortController();
    const hang = ((url: string, init: RequestInit) => (String(url).endsWith('/api/show') ? Promise.resolve(Response.json({ capabilities: [] })) : new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))) as unknown as typeof fetch;
    const client = createOllamaClient(options({ fetch: hang }));
    const pending = client.messages.stream({ model: 'qwen3:8b', max_tokens: 10, messages: [{ role: 'user', content: 'q' }] }, { signal: abort.signal, timeout: 5000 }).finalMessage();
    setTimeout(() => abort.abort(), 20);
    const err = await pending.catch(e => e);
    expect(err).not.toBeInstanceOf(ProviderError);
  });

  it('sends the gateway token as a bearer header and nowhere else', async () => {
    const { fetch, requests } = fakeOllama([text('ок')]);
    const { events } = await chat({ ...ENV, OLLAMA_BASE_URL: 'https://llm.example.com/', OLLAMA_API_KEY: 'gw-secret' }, fetch);
    expect(requests[0].url).toBe('https://llm.example.com/api/chat');
    expect(requests[0].headers.Authorization).toBe('Bearer gw-secret');
    expect(JSON.stringify(events) + JSON.stringify(requests[0].body)).not.toContain('gw-secret');
  });
});
