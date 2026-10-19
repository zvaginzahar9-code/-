import type Anthropic from '@anthropic-ai/sdk';
import type { ErrorCode } from '../src/assistant/protocol.ts';
import type { ModelClient } from './orchestrator.ts';

/**
 * Local models through Ollama's /api/chat. The conversation loop (orchestrator.ts) speaks
 * one message format; this adapter translates it to Ollama's and back, so the tools, the
 * limits and the event stream are identical for every provider.
 *
 * Two ways of letting the model call tools:
 *  - `native`: Ollama's own tool calling. Verified to work with qwen3:8b.
 *  - `json`:   two small steps instead of one big one. First a short routing prompt with
 *              examples, whose reply is constrained by a JSON schema (Ollama's `format`) to
 *              "call this tool with these arguments" or "answer". Then, for an answer, a
 *              plain streamed reply written from the tool results. For models whose native
 *              tool calling is unreliable with this many tools: mistral:latest, given the
 *              full prompt, called nothing and made the data up.
 * Either way the call is only a request: tools.ts validates it and runs it.
 */

/** A failure with a code the visitor-facing layer already knows how to word. */
export class ProviderError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;
  readonly status?: number;
  constructor(code: ErrorCode, detail: string, status?: number) {
    super(detail);
    this.name = 'ProviderError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export type ToolMode = 'native' | 'json';

export interface OllamaOptions {
  baseUrl: string;
  /** bearer token for a gateway placed in front of Ollama; plain local Ollama needs none */
  apiKey: string | null;
  /** context window to request, tokens */
  numCtx: number;
  /** how long the model stays in memory after a request (Ollama duration, e.g. "30m", "0") */
  keepAlive: string;
  /** let a reasoning-capable model think before answering (native mode only; slower first token) */
  think: boolean;
  toolMode: ToolMode;
  fetch?: typeof fetch;
}

interface OllamaToolCall {
  function: { name: string; arguments: unknown };
}
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}
interface OllamaChunk {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  /** nanoseconds, as reported by the model server */
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  error?: string;
}

/** Where the time of one request to the model server went. */
export interface RequestTiming {
  step: 'route' | 'answer' | 'native';
  /** wall time of the whole request, and until the first piece of output */
  ms: number;
  firstMs: number;
  /** from the model server's own counters */
  loadMs: number;
  promptMs: number;
  genMs: number;
  inTokens: number;
  outTokens: number;
}
type Tool = Anthropic.Tool;
interface Call {
  name: string;
  input: unknown;
}

const MAX_OUTPUT_TOKENS = 1024;
const customTools = (tools: Anthropic.MessageStreamParams['tools']): Tool[] => (tools ?? []).filter((t): t is Tool => 'input_schema' in t);

/** Tool results belong to the call with the same id in the preceding assistant message. */
function toolNames(messages: Anthropic.MessageParam[], index: number) {
  const names = new Map<string, string>();
  const prev = messages[index - 1];
  if (prev && typeof prev.content !== 'string') for (const b of prev.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  return names;
}
const resultText = (content: Anthropic.ToolResultBlockParam['content']) => (typeof content === 'string' ? content : JSON.stringify(content ?? ''));

function nativeMessages(body: Anthropic.MessageStreamParams): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (typeof body.system === 'string' && body.system) out.push({ role: 'system', content: body.system });
  body.messages.forEach((m, i) => {
    if (typeof m.content === 'string') return void out.push({ role: m.role, content: m.content });
    if (m.role === 'assistant') {
      let content = '';
      const calls: OllamaToolCall[] = [];
      for (const b of m.content) {
        if (b.type === 'text') content += b.text;
        else if (b.type === 'tool_use') calls.push({ function: { name: b.name, arguments: b.input } });
      }
      return void out.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) });
    }
    const names = toolNames(body.messages, i);
    for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_name: names.get(b.tool_use_id) ?? 'tool', content: resultText(b.content) });
  });
  return out;
}

// ── json mode ──────────────────────────────────────────────

const ROUTER_PROMPT = `Ты — диспетчер ассистента на сайте завода стальных опор ЛЭП. Твоя единственная задача — выбрать следующий шаг. Отвечай одним JSON-объектом.

Шаги:
- search_catalog — найти или подобрать опоры (по классу напряжения, марке, высоте, массе).
- get_tower_details — показать характеристики одной опоры.
- compare_towers — сравнить 2–3 опоры в чате.
- open_tower_sheet — открыть на сайте чертёж опоры.
- go_to_section — перейти к разделу сайта: catalog, production, experience, request, contacts, top.
- filter_catalog — показать в каталоге на странице группу опор (класс напряжения, вид «таблица» или «линейка»).
- open_comparison — открыть сравнение на странице.
- prepare_inquiry — подготовить черновик заявки на расчёт.
- answer — ничего не вызывать и ответить текстом: вопрос о компании, благодарность, уточнение, либо все нужные данные уже получены.

Правила:
1. Любой вопрос об опорах, их характеристиках или подборе требует инструмента. Не выбирай answer, если данных из каталога для ответа ещё нет.
2. Подбор по высоте, массе, проводу или нескольким условиям сразу — это всегда search_catalog. filter_catalog нужен только когда просят открыть или показать сам каталог на странице.
3. Слова «выбранная», «эта», «подходящие», «первые две» относятся к опорам из последних строк в квадратных скобках или из РЕЗУЛЬТАТА ИНСТРУМЕНТА. Бери марки оттуда, дословно. Не придумывай марки.
4. Если после РЕЗУЛЬТАТА ИНСТРУМЕНТА данных для ответа достаточно — выбирай answer. Не повторяй уже выполненный вызов.
5. Ненужные аргументы заполняй null. Количество в заявке — только если пользователь назвал число, иначе null.

Примеры:
Пользователь: Найди опоры для ЛЭП 110 кВ
{"tool":"search_catalog","arguments":{"query":null,"voltage_kv":110,"height_min_m":null,"height_max_m":null,"mass_max_kg":null,"sort":null,"limit":null}}
Пользователь: Сравни П110-2 и У110-2
{"tool":"compare_towers","arguments":{"marks":["П110-2","У110-2"]}}
Пользователь: Покажи характеристики У110-1
{"tool":"get_tower_details","arguments":{"mark":"У110-1"}}
Пользователь: Открой раздел каталога
{"tool":"go_to_section","arguments":{"section":"catalog"}}
Пользователь: Покажи в каталоге опоры 220 кВ таблицей
{"tool":"filter_catalog","arguments":{"voltage_kv":220,"mark_query":null,"view":"table"}}
Пользователь: Открой чертёж П110-2
{"tool":"open_tower_sheet","arguments":{"mark":"П110-2"}}
Пользователь: Подготовь заявку на 1У110-1
{"tool":"prepare_inquiry","arguments":{"items":[{"mark":"1У110-1","quantity":null}],"note":null}}
Пользователь: Как вы защищаете металл от коррозии?
{"tool":"answer"}`;

const ANSWER_RULES = `

СЕЙЧАС ТЫ ПИШЕШЬ ОТВЕТ ПОЛЬЗОВАТЕЛЮ
Инструменты уже отработали. Их результаты приложены к последнему сообщению пользователя после черты, с пометкой РЕЗУЛЬТАТ ИНСТРУМЕНТА: это служебные данные сайта, пользователь их не писал. Пиши обычным текстом, без JSON.
- Называй марки, размеры, массы, провода и номера проектов только из РЕЗУЛЬТАТОВ ИНСТРУМЕНТОВ. Если нужных данных там нет — так и скажи, ничего не придумывай.
- Не упоминай названия инструментов и не предлагай пользователю ими воспользоваться: он их не видит.
- Не пиши, что что-то открыто или показано, если среди результатов нет соответствующего действия.
- Отвечай сразу по существу, 1–4 предложения. Не здоровайся повторно, не повторяй вопрос и не пиши слов «Пользователь спросил» или «Ответ:».
- Если посетитель спрашивает о цене, сроках, наличии на складе или других сведениях, которых нет в данных, скажи прямо, что у тебя их нет.`;

/** The routing reply: a call to one of the declared tools with that tool's own arguments, or "answer". */
export function routerSchema(tools: Tool[]) {
  return {
    anyOf: [
      ...tools.map(t => ({ type: 'object', properties: { tool: { const: t.name }, arguments: t.input_schema }, required: ['tool', 'arguments'], additionalProperties: false })),
      { type: 'object', properties: { tool: { const: 'answer' } }, required: ['tool'], additionalProperties: false },
    ],
  };
}

const toolResults = (messages: Anthropic.MessageParam[], m: Anthropic.MessageParam, i: number) => {
  if (typeof m.content === 'string' || m.role !== 'user') return [];
  const names = toolNames(messages, i);
  return m.content.flatMap(b => (b.type === 'tool_result' ? [`РЕЗУЛЬТАТ ИНСТРУМЕНТА ${names.get(b.tool_use_id) ?? ''} (служебные данные сайта, это не реплика пользователя):\n${resultText(b.content)}`] : []));
};

/** Tool calls and results made since the visitor's last message. */
function thisTurn(messages: Anthropic.MessageParam[]) {
  let from = messages.length;
  while (from > 0 && typeof messages[from - 1].content !== 'string') from--;
  const results: string[] = [];
  let succeeded = false;
  for (let i = from; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m.content === 'string' || m.role !== 'user') continue;
    results.push(...toolResults(messages, m, i));
    if (m.content.some(b => b.type === 'tool_result' && !b.is_error)) succeeded = true;
  }
  return { from, results, succeeded };
}
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

/**
 * The dialogue as the routing step sees it: its own short prompt with examples, the recent turns,
 * then this turn's calls and results. A small model chooses tools far better from this than from
 * the full rules (measured: with the routing task appended to the full prompt, mistral lost the
 * conditions of a follow-up question and stopped preparing inquiries).
 *
 * Cost of the two different prompts: the model server keeps the state of a prompt it stops
 * continuing in its in-memory prompt cache (llama-server, limit 8192 MiB), so a long session in
 * this mode can add up to ~8 GB to the model process. See README, «Память».
 */
function routerMessages(body: Anthropic.MessageStreamParams): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: 'system', content: ROUTER_PROMPT }];
  body.messages.forEach((m, i) => {
    if (typeof m.content === 'string') return void out.push({ role: m.role, content: m.role === 'assistant' ? clip(m.content, 900) : m.content });
    if (m.role === 'assistant') {
      for (const b of m.content) if (b.type === 'tool_use') out.push({ role: 'assistant', content: JSON.stringify({ tool: b.name, arguments: b.input }) });
      return;
    }
    const results = toolResults(body.messages, m, i);
    if (results.length) out.push({ role: 'user', content: `${results.map(r => clip(r, 1500)).join('\n\n')}\n\nВыбери следующий шаг: ещё один инструмент или answer.` });
  });
  return out;
}

/** The dialogue for the writing step: the rules, the history, then the question with the tool results attached. */
function answerMessages(body: Anthropic.MessageStreamParams): OllamaMessage[] {
  const { from, results } = thisTurn(body.messages);
  const out: OllamaMessage[] = [{ role: 'system', content: `${typeof body.system === 'string' ? body.system : ''}${ANSWER_RULES}` }];
  for (const m of body.messages.slice(0, from)) if (typeof m.content === 'string') out.push({ role: m.role, content: m.content });
  if (results.length) {
    const question = out[out.length - 1];
    question.content = `${question.content}\n\n———\n${results.map(r => clip(r, 5000)).join('\n\n')}`;
  }
  return out;
}

// ── text hygiene ───────────────────────────────────────────

/**
 * A tool call some models write into the text instead of the tool-call field:
 * {"name": "...", "arguments": {...}} — bare, in a code fence, or after a [TOOL_CALLS] marker.
 */
export function parseTextToolCalls(text: string, known: Set<string>): Call[] | null {
  const s = text.trim().replace(/^\[TOOL_CALLS\]\s*/i, '').replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  const calls: Call[] = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const fn = (o.function && typeof o.function === 'object' ? o.function : o) as Record<string, unknown>;
    const name = fn.name ?? fn.tool;
    if (typeof name !== 'string' || !known.has(name)) return null;
    let args = fn.arguments ?? fn.parameters ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return null;
      }
    }
    calls.push({ name, input: args });
  }
  return calls.length ? calls : null;
}

/**
 * The interface records what really happened on the page as bracketed notes in the history.
 * A model that imitates them would be claiming an action it did not take, so such lines
 * (and bare "Действие: …" lines) never reach the visitor. Works on a stream: text is released
 * as it comes, and a line is held back only while it may still turn out to be such a note.
 */
export function createLineFilter(emit: (text: string) => void) {
  let line = '';
  let passing = false; // the current line is already known to be ordinary text
  // also dropped: Markdown table rows — the interface shows comparisons as its own table block
  const isNote = (l: string) => /^\s*\[[^\]]*\]\s*$/.test(l) || /^\s*Действие\s*:/i.test(l) || /^\s*\|/.test(l);
  const mayBeNote = (l: string) => {
    const s = l.trimStart().toLowerCase();
    return s === '' || s.startsWith('[') || s.startsWith('|') || 'действие:'.startsWith(s) || /^действие\s*:/.test(s) || /^действие\s*$/.test(s);
  };
  return {
    push(text: string) {
      for (const ch of text) {
        if (ch === '\n') {
          if (passing) emit('\n');
          else if (!isNote(line)) emit(`${line}\n`);
          line = '';
          passing = false;
        } else if (passing) emit(ch);
        else {
          line += ch;
          if (!mayBeNote(line)) {
            emit(line);
            passing = true;
          }
        }
      }
    },
    end() {
      if (!passing && line && !isNote(line)) emit(line);
      line = '';
    },
  };
}

const stripThink = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart();

/** Could this beginning of a native-mode reply still become a text tool call or hidden reasoning? */
const mayBeHidden = (head: string) => {
  const s = head.trimStart();
  return s === '' || s.startsWith('{') || s.startsWith('```') || '<think>'.startsWith(s) || '[TOOL_CALLS]'.startsWith(s.toUpperCase()) || s.toUpperCase().startsWith('[TOOL_CALLS]');
};

// ── client ─────────────────────────────────────────────────

export function createOllamaClient(o: OllamaOptions): ModelClient {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) };
  /** whether each model accepts the `think` switch; asked once per model */
  const thinking = new Map<string, Promise<boolean>>();
  const canThink = (model: string) => {
    let known = thinking.get(model);
    if (!known) {
      known = doFetch(`${base}/api/show`, { method: 'POST', headers, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000), redirect: 'error' })
        .then(async r => (r.ok ? ((await r.json()) as { capabilities?: string[] }).capabilities?.includes('thinking') === true : false))
        .catch(() => {
          thinking.delete(model); // a passing failure must not decide this for good
          return false;
        });
      thinking.set(model, known);
    }
    return known;
  };

  /** Sends one request and feeds each streamed chunk to `onChunk`; resolves with the final chunk. */
  async function chat(step: RequestTiming['step'], timings: RequestTiming[], request: Record<string, unknown>, signal: AbortSignal, timedOut: () => boolean, cancelled: () => boolean, onChunk: (c: OllamaChunk) => void): Promise<OllamaChunk> {
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await doFetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify(request), signal, redirect: 'error' });
    } catch (e) {
      if (cancelled()) throw e;
      throw new ProviderError(timedOut() ? 'timeout' : 'unavailable', `cannot reach the model server at ${base}`);
    }
    if (!res.ok || !res.body) {
      const status = res.status;
      await res.body?.cancel().catch(() => {});
      if (status === 404) throw new ProviderError('not_configured', `model ${String(request.model)} is not installed on the model server`, status);
      if (status === 401 || status === 403) throw new ProviderError('not_configured', 'the model server rejected the credentials', status);
      throw new ProviderError(status === 429 || status === 503 ? 'rate_limited' : 'provider', `model server answered ${status}`, status);
    }
    let last: OllamaChunk = {};
    let buffer = '';
    let firstAt = 0;
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(line);
          } catch {
            throw new ProviderError('provider', 'malformed chunk from the model server');
          }
          if (chunk.error) throw new ProviderError('provider', `the model server reported an error: ${String(chunk.error).slice(0, 200)}`);
          if (!firstAt && (chunk.message?.content || chunk.message?.tool_calls)) firstAt = Date.now();
          onChunk(chunk);
          if (chunk.done) last = chunk;
        }
      }
    } catch (e) {
      if (e instanceof ProviderError || cancelled()) throw e;
      throw new ProviderError(timedOut() ? 'timeout' : 'unavailable', 'the model server stopped responding');
    } finally {
      void reader.cancel().catch(() => {});
    }
    if (!last.done) throw new ProviderError('provider', 'the model server closed the stream early');
    // the prompt must fit the context window: the model server would otherwise cut the rules off silently
    if ((last.prompt_eval_count ?? 0) >= o.numCtx - 16) throw new ProviderError('provider', `the prompt filled the context window (${last.prompt_eval_count} of ${o.numCtx} tokens)`);
    const ns = (v?: number) => Math.round((v ?? 0) / 1e6);
    timings.push({ step, ms: Date.now() - startedAt, firstMs: (firstAt || Date.now()) - startedAt, loadMs: ns(last.load_duration), promptMs: ns(last.prompt_eval_duration), genMs: ns(last.eval_duration), inTokens: last.prompt_eval_count ?? 0, outTokens: last.eval_count ?? 0 });
    return last;
  }

  return {
    messages: {
      stream(body, options) {
        const listeners: ((delta: string) => void)[] = [];
        const filter = createLineFilter(d => d && listeners.forEach(l => l(d)));
        return {
          on(_event, listener) {
            listeners.push(listener);
            return this;
          },
          async finalMessage(): Promise<Anthropic.Message> {
            const timeout = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              timeout.abort();
            }, options?.timeout ?? 120_000);
            const onAbort = () => timeout.abort();
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            const tools = customTools(body.tools);
            const known = new Set(tools.map(t => t.name));
            const timings: RequestTiming[] = [];
            const common = { model: body.model, stream: true, keep_alive: o.keepAlive, options: { temperature: 0.2, num_ctx: o.numCtx, num_predict: MAX_OUTPUT_TOKENS } };
            const run = (step: RequestTiming['step'], request: Record<string, unknown>, onChunk: (c: OllamaChunk) => void) =>
              chat(step, timings, request, timeout.signal, () => timedOut, () => options?.signal?.aborted === true, onChunk);
            try {
              let text = '';
              let calls: Call[] = [];
              let last: OllamaChunk;

              if (o.toolMode === 'json' && tools.length) {
                // step 1: route. Short prompt, reply constrained to a declared tool or "answer".
                let raw = '';
                // one successful tool per visitor message: left to itself a small model keeps
                // calling tools nobody asked for. A failed call may be corrected once.
                const turn = thisTurn(body.messages);
                const mustAnswer = turn.succeeded || turn.results.length >= 2;
                const route: Record<string, unknown> = { ...common, messages: routerMessages(body), format: routerSchema(tools), options: { ...common.options, temperature: 0, num_predict: 320 } };
                if (await canThink(body.model)) route.think = false;
                let decision: { tool?: unknown; arguments?: unknown } = { tool: 'answer' };
                last = {};
                if (!mustAnswer) {
                  last = await run('route', route, c => {
                    raw += c.message?.content ?? '';
                  });
                  try {
                    decision = JSON.parse(raw);
                  } catch {
                    throw new ProviderError('provider', 'the model did not return a routing decision');
                  }
                }
                if (typeof decision.tool === 'string' && known.has(decision.tool)) calls = [{ name: decision.tool, input: decision.arguments ?? {} }];
                else {
                  // step 2: write the answer from what the tools returned
                  const write: Record<string, unknown> = { ...common, messages: answerMessages(body) };
                  if (await canThink(body.model)) write.think = false;
                  const routed = last;
                  last = await run('answer', write, c => {
                    if (!c.message?.content) return;
                    text += c.message.content;
                    filter.push(c.message.content);
                  });
                  text = stripThink(text);
                  last = { ...last, prompt_eval_count: (last.prompt_eval_count ?? 0) + (routed.prompt_eval_count ?? 0), eval_count: (last.eval_count ?? 0) + (routed.eval_count ?? 0) };
                }
              } else {
                let content = '';
                let sent = 0;
                let hidden = true; // nothing is shown while the reply may still be a tool call or reasoning
                const native: OllamaToolCall[] = [];
                const request: Record<string, unknown> = { ...common, messages: nativeMessages(body), tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } })) };
                if (await canThink(body.model)) request.think = o.think;
                last = await run('native', request, c => {
                  if (c.message?.tool_calls) native.push(...c.message.tool_calls);
                  if (!c.message?.content) return;
                  content += c.message.content;
                  if (hidden) {
                    const visible = stripThink(content);
                    const stillThinking = content.trimStart().startsWith('<think>') && !content.includes('</think>');
                    if (!stillThinking && visible && !mayBeHidden(visible)) {
                      hidden = false;
                      sent = content.length - visible.length;
                    }
                  }
                  if (!hidden) {
                    filter.push(content.slice(sent));
                    sent = content.length;
                  }
                });
                text = stripThink(content);
                // a call to an undeclared tool is not dropped: it goes through the loop, where it is refused and the model is told
                calls = native.filter(c => typeof c.function?.name === 'string').map(c => ({ name: c.function.name, input: c.function.arguments }));
                if (!calls.length && hidden) {
                  const fromText = parseTextToolCalls(text, known);
                  if (fromText) {
                    calls = fromText;
                    text = '';
                  } else filter.push(text); // it was ordinary text after all
                }
              }
              filter.end();

              const blocks: unknown[] = [];
              if (text.trim() && !calls.length) blocks.push({ type: 'text', text, citations: null });
              calls.forEach((c, i) => {
                let input = c.input;
                if (typeof input === 'string') {
                  try {
                    input = JSON.parse(input);
                  } catch {
                    // left as a string: the tool refuses it, rather than running with no conditions
                  }
                }
                blocks.push({ type: 'tool_use', id: `call_${Date.now().toString(36)}_${i}`, name: c.name, input });
              });
              return {
                id: 'ollama',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: blocks,
                stop_reason: calls.length ? 'tool_use' : last.done_reason === 'length' ? 'max_tokens' : 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: last.prompt_eval_count ?? 0, output_tokens: last.eval_count ?? 0 },
                timings,
              } as unknown as Anthropic.Message;
            } finally {
              clearTimeout(timer);
              options?.signal?.removeEventListener('abort', onAbort);
            }
          },
        };
      },
    },
  };
}
