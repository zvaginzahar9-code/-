import type Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from './ollama.ts';
import type { ModelClient } from './orchestrator.ts';

/**
 * Google Gemini through the Interactions API (POST /v1beta/interactions), the interface
 * Google recommends for new code. Like the Ollama adapter, this one translates the
 * conversation loop's message format to the provider's and back, so the tools, the limits,
 * the fact check and the event stream are the same for every provider.
 *
 * Tool round trips use the documented stateful flow: the request that produced a function
 * call is continued by id (`previous_interaction_id`) with the function results. That keeps
 * the model's own reasoning steps on Google's side instead of reconstructing them here.
 * Consequence: interactions are stored by Google (1 day on the free tier, 55 on paid).
 *
 * The API key is sent in the `x-goog-api-key` header and appears nowhere else.
 */

export interface GeminiOptions {
  apiKey: string;
  baseUrl: string;
  thinkingLevel: 'minimal' | 'low' | 'medium' | 'high';
  fetch?: typeof fetch;
}

type Tool = Anthropic.Tool;
interface FunctionCallStep {
  id: string;
  name: string;
  args: string;
  parsed?: unknown;
}
interface StreamEvent {
  event_type?: string;
  type?: string;
  index?: number;
  interaction?: { id?: string; status?: string; usage?: Record<string, number>; errors?: { code?: string; message?: string }[] };
  status?: string;
  usage?: Record<string, number>;
  step?: { type?: string; id?: string; name?: string; arguments?: unknown };
  delta?: { type?: string; text?: string; partial_arguments?: string; arguments?: unknown };
  error?: { code?: string; message?: string };
}

const MAX_OUTPUT_TOKENS = 2048;
/** generation was stopped by a content policy, not by a fault */
const BLOCKED = new Set(['safety', 'recitation', 'language', 'prohibited_content', 'spii', 'blocklist', 'content_blocked']);

/**
 * The tools are declared with nullable arguments ("type": ["string", "null"]). Gemini's schema
 * dialect is narrower, so each nullable argument becomes a plain optional one: the null is
 * dropped from the type and the enum, and the key leaves `required`. tools.ts treats a missing
 * argument and a null one alike.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && Array.isArray(value)) out.type = value.find(t => t !== 'null') ?? 'string';
    else if (key === 'enum' && Array.isArray(value)) out.enum = value.filter(v => v !== null);
    else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else out[key] = toGeminiSchema(value);
  }
  if (Array.isArray(src.required) && src.properties && typeof src.properties === 'object') {
    const props = src.properties as Record<string, { type?: unknown }>;
    out.required = (src.required as string[]).filter(k => !(Array.isArray(props[k]?.type) && (props[k].type as unknown[]).includes('null')));
  }
  return out;
}

const declare = (tools: Tool[]) => tools.map(t => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: toGeminiSchema(t.input_schema) }));
const textItem = (text: string) => [{ type: 'text', text }];

function classify(status: number, code: string | undefined): ProviderError {
  const detail = `gemini answered ${status}${code ? ` (${code})` : ''}`;
  if (status === 401 || status === 403 || status === 404 || code === 'authentication' || code === 'permission_denied' || code === 'model_not_found' || code === 'failed_precondition' || code === 'payment_required') {
    return new ProviderError('not_configured', detail, status);
  }
  if (status === 429) return new ProviderError('rate_limited', detail, status);
  if (status === 504 || code === 'deadline_exceeded') return new ProviderError('timeout', detail, status);
  if (status === 503) return new ProviderError('unavailable', detail, status);
  return new ProviderError('provider', detail, status);
}

export function createGeminiClient(o: GeminiOptions): ModelClient {
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  /** function call id → the interaction that asked for it, so its result can continue that interaction */
  const pending = new Map<string, { interaction: string; name: string }>();

  return {
    messages: {
      stream(body, options) {
        const listeners: ((delta: string) => void)[] = [];
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
            }, options?.timeout ?? 40_000);
            const onAbort = () => timeout.abort();
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            const cancelled = () => options?.signal?.aborted === true;
            const tools = (body.tools ?? []).filter((t): t is Tool => 'input_schema' in t);

            // either a new question (the dialogue so far) or the results of the calls just made
            const last = body.messages[body.messages.length - 1];
            const results = typeof last.content === 'string' ? [] : last.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result');
            const request: Record<string, unknown> = {
              model: body.model,
              system_instruction: typeof body.system === 'string' ? body.system : '',
              tools: declare(tools),
              stream: true,
              generation_config: { temperature: 0.2, max_output_tokens: Math.min(body.max_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS), thinking_level: o.thinkingLevel },
            };
            if (results.length) {
              const origin = results.map(r => pending.get(r.tool_use_id)).find(Boolean);
              if (!origin) throw new ProviderError('provider', 'a tool result has no interaction to continue');
              request.previous_interaction_id = origin.interaction;
              request.input = results.map(r => ({
                type: 'function_result',
                name: pending.get(r.tool_use_id)?.name ?? '',
                call_id: r.tool_use_id,
                result: textItem(typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '')),
                ...(r.is_error ? { is_error: true } : {}),
              }));
              for (const r of results) pending.delete(r.tool_use_id);
            } else {
              request.input = body.messages.flatMap(m => (typeof m.content === 'string' ? [{ type: m.role === 'user' ? 'user_input' : 'model_output', content: textItem(m.content) }] : []));
            }

            try {
              let res: Response;
              try {
                res = await doFetch(`${base}/v1beta/interactions?alt=sse`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': o.apiKey },
                  body: JSON.stringify(request),
                  signal: timeout.signal,
                  redirect: 'error',
                });
              } catch (e) {
                if (cancelled()) throw e;
                throw new ProviderError(timedOut ? 'timeout' : 'unavailable', 'cannot reach the Gemini API');
              }
              if (!res.ok || !res.body) {
                let code: string | undefined;
                try {
                  const parsed = (await res.json()) as { error?: { code?: string; status?: string } };
                  code = typeof parsed.error?.code === 'string' ? parsed.error.code : parsed.error?.status?.toLowerCase();
                } catch {
                  /* no JSON body: the status alone decides */
                }
                throw classify(res.status, code);
              }

              let interaction = '';
              let status = '';
              let usage: Record<string, number> = {};
              let text = '';
              const calls = new Map<number, FunctionCallStep>();
              let failure: { code?: string; message?: string } | null = null;

              const handle = (e: StreamEvent) => {
                const kind = e.event_type ?? e.type ?? '';
                if (e.interaction?.id) interaction = e.interaction.id;
                if (e.interaction?.status) status = e.interaction.status;
                if (e.interaction?.usage) usage = e.interaction.usage;
                if (e.interaction?.errors?.length) failure = e.interaction.errors[0];
                if (kind === 'interaction.status_update' || kind.startsWith('interaction.')) {
                  if (e.status) status = e.status;
                  if (e.usage) usage = e.usage;
                  const named = kind.slice('interaction.'.length);
                  if (['completed', 'requires_action', 'failed', 'incomplete', 'cancelled'].includes(named) && !e.interaction?.status && !e.status) status = named;
                } else if (kind === 'step.start' && e.step?.type === 'function_call' && typeof e.index === 'number') {
                  calls.set(e.index, { id: e.step.id ?? '', name: e.step.name ?? '', args: '', parsed: e.step.arguments });
                } else if (kind === 'step.delta' && e.delta) {
                  if (e.delta.type === 'text' && e.delta.text) {
                    text += e.delta.text;
                    listeners.forEach(l => l(e.delta!.text!));
                  } else if (e.delta.type === 'arguments' && typeof e.index === 'number') {
                    const call = calls.get(e.index);
                    if (call) {
                      if (typeof e.delta.partial_arguments === 'string') call.args += e.delta.partial_arguments;
                      else if (e.delta.arguments !== undefined) call.parsed = e.delta.arguments;
                    }
                  }
                } else if (kind === 'error') failure = e.error ?? { code: 'api_error' };
              };

              let buffer = '';
              const decoder = new TextDecoder();
              const reader = res.body.getReader();
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
                    try {
                      handle(JSON.parse(data));
                    } catch (e) {
                      if (e instanceof ProviderError) throw e;
                      throw new ProviderError('provider', 'malformed event from the Gemini API');
                    }
                  }
                }
              } catch (e) {
                if (e instanceof ProviderError || cancelled()) throw e;
                throw new ProviderError(timedOut ? 'timeout' : 'unavailable', 'the Gemini API stopped responding');
              } finally {
                void reader.cancel().catch(() => {});
              }

              const stopped = failure as { code?: string; message?: string } | null;
              if (stopped) {
                if (stopped.code && BLOCKED.has(stopped.code)) status = 'blocked';
                else if (stopped.code === 'rate_limit_exceeded' || stopped.code === 'quota_exceeded' || stopped.code === 'too_many_requests') throw new ProviderError('rate_limited', `gemini stream error (${stopped.code})`);
                else throw new ProviderError(stopped.code === 'service_unavailable' ? 'unavailable' : 'provider', `gemini stream error (${stopped.code ?? 'unknown'})`);
              }
              // a stream that ends while the interaction is still running was cut off
              const terminal = ['completed', 'requires_action', 'incomplete', 'failed', 'cancelled', 'blocked'].includes(status);
              if (!terminal) throw new ProviderError('provider', 'the Gemini API closed the stream without a final status');
              if (status === 'failed' || status === 'cancelled') throw new ProviderError('provider', `gemini interaction ${status}`);

              const blocks: unknown[] = [];
              const made = [...calls.values()].filter(c => c.id && c.name);
              if (text.trim() && !made.length) blocks.push({ type: 'text', text, citations: null });
              for (const call of made) {
                let input: unknown = call.parsed;
                if (input === undefined && call.args) {
                  try {
                    input = JSON.parse(call.args);
                  } catch {
                    input = call.args; // left as a string: the tool refuses it rather than running without conditions
                  }
                }
                pending.set(call.id, { interaction, name: call.name });
                blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: input ?? {} });
              }
              // calls whose results never come back (a cancelled turn) must not pile up
              while (pending.size > 200) pending.delete(pending.keys().next().value!);

              return {
                id: interaction || 'gemini',
                type: 'message',
                role: 'assistant',
                model: body.model,
                content: blocks,
                stop_reason: status === 'blocked' ? 'refusal' : made.length ? 'tool_use' : status === 'incomplete' ? 'max_tokens' : 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: usage.total_input_tokens ?? usage.prompt_tokens ?? 0, output_tokens: usage.total_output_tokens ?? usage.completion_tokens ?? 0 },
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
