import Anthropic from '@anthropic-ai/sdk';
import type { ErrorCode, ServerEvent } from '../src/assistant/protocol.ts';
import { SSE_HEADERS, USER_MESSAGES, clientKey, createRateLimiter, encodeEvent, errorResponse, originAllowed, parseBody, readConfig, trimHistory, type AssistantConfig } from './http.ts';
import { createGeminiClient } from './gemini.ts';
import { ProviderError, createOllamaClient } from './ollama.ts';
import { runTurn, type ModelClient, type TurnLimits } from './orchestrator.ts';

/**
 * POST /api/chat — one assistant turn, streamed as server-sent events.
 * GET  /api/chat — whether the assistant is configured (no secrets, no model name).
 * The model is chosen by configuration: a local one through Ollama (the default in development),
 * Google Gemini (the default on the published site when its key is set) or the Anthropic API. Addresses and keys are read on the server and never leave it.
 */

const MAX_BODY_BYTES = 100_000;
const perMinute = createRateLimiter(10, 60_000);
const perHour = createRateLimiter(80, 3_600_000);

export interface HandlerDeps {
  env?: Record<string, string | undefined>;
  /** tests and local preview inject a scripted client; production builds the real one */
  createClient?: (config: AssistantConfig) => ModelClient;
  limit?: (key: string) => { ok: boolean; retryAfter: number };
}

/** Read without Node's type package, so this file compiles under the function's own tsconfig. */
const runtimeEnv = () => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/** A local model on a laptop is slow to load and to answer, and has a small context window. */
const LOCAL: { limits: Partial<TurnLimits>; historyChars: number; concurrent: number } = {
  limits: { requestTimeoutMs: 150_000, turnTimeoutMs: 270_000, maxOutputTokens: 1024 },
  historyChars: 6000,
  concurrent: 2,
};
let running = 0;

function createClient(config: AssistantConfig): ModelClient {
  if (config.provider === 'ollama') return createOllamaClient({ baseUrl: config.ollama.baseUrl!, apiKey: config.ollama.apiKey, numCtx: config.ollama.numCtx, keepAlive: config.ollama.keepAlive, think: config.ollama.think, toolMode: config.ollama.toolMode });
  if (config.provider === 'gemini') return createGeminiClient({ apiKey: config.gemini.apiKey!, baseUrl: config.gemini.baseUrl, thinkingLevel: config.gemini.thinkingLevel });
  return new Anthropic({ apiKey: config.apiKey!, maxRetries: 1 }) as unknown as ModelClient;
}

function classify(err: unknown): ErrorCode {
  if (err instanceof ProviderError) return err.code;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'timeout';
  if (err instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return 'not_configured';
  return 'provider';
}

export async function handle(request: Request, deps: HandlerDeps = {}): Promise<Response> {
  const config = readConfig(deps.env ?? runtimeEnv());

  if (request.method === 'GET') {
    return Response.json({ configured: config.configured }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  if (!originAllowed(request)) return errorResponse('forbidden');
  if (!request.headers.get('content-type')?.trim().toLowerCase().startsWith('application/json')) return errorResponse('bad_request');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return errorResponse('bad_request');

  const key = clientKey(request);
  const gate = deps.limit ? deps.limit(key) : [perMinute(key), perHour(key)].find(r => !r.ok) ?? { ok: true, retryAfter: 0 };
  if (!gate.ok) return errorResponse('rate_limited', { 'Retry-After': String(gate.retryAfter) });

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return errorResponse('bad_request');
  }
  if (raw.length > MAX_BODY_BYTES) return errorResponse('bad_request');
  let history;
  try {
    history = parseBody(JSON.parse(raw));
  } catch {
    history = null;
  }
  if (!history) return errorResponse('bad_request');
  if (!config.configured) return errorResponse('not_configured');

  const local = config.provider === 'ollama';
  // a laptop serves one answer at a time well; more would only queue up behind it
  if (local && running >= LOCAL.concurrent) return errorResponse('rate_limited', { 'Retry-After': '20' });
  if (local) history = trimHistory(history, LOCAL.historyChars);
  const client = deps.createClient ? deps.createClient(config) : createClient(config);
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const started = Date.now();
  const turn = history;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      running++;
      const emit = (event: ServerEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(encodeEvent(event)));
        } catch {
          open = false;
        }
      };
      try {
        const report = await runTurn({ client, model: config.model, effort: config.effort, history: turn, emit, signal: abort.signal, ...(local ? { limits: LOCAL.limits } : {}) });
        // operational log: no message text, no client address
        console.log(JSON.stringify({ evt: 'assistant_turn', provider: config.provider, model: config.model, ...(local ? { toolMode: config.ollama.toolMode } : {}), ms: Date.now() - started, ...report }));
      } catch (err) {
        if (!abort.signal.aborted) {
          const code = classify(err);
          console.error(JSON.stringify({ evt: 'assistant_error', code, ms: Date.now() - started, provider: config.provider, status: err instanceof Anthropic.APIError || err instanceof ProviderError ? err.status : undefined, detail: err instanceof ProviderError ? err.detail : undefined, name: err instanceof Error ? err.name : 'unknown' }));
          emit({ t: 'retract' }); // whatever was streamed has not passed the fact check
          emit({ t: 'error', code, message: USER_MESSAGES[code] });
        }
      } finally {
        running--;
        open = false;
        try {
          controller.close();
        } catch {
          /* the client has already gone */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(body, { headers: SSE_HEADERS });
}
