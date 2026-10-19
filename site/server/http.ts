import { LIMITS, type ChatTurn, type ErrorCode, type ServerEvent } from '../src/assistant/protocol.ts';

/** Request validation, origin check, rate limiting and SSE framing for /api/chat. */

export type ProviderName = 'ollama' | 'gemini' | 'anthropic';

export interface AssistantConfig {
  provider: ProviderName;
  model: string;
  /** whether the chosen provider has what it needs to be called */
  configured: boolean;
  /** anthropic */
  apiKey: string | null;
  effort: 'low' | 'medium' | 'high';
  /** gemini */
  gemini: { apiKey: string | null; baseUrl: string; thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' };
  /** ollama */
  ollama: { baseUrl: string | null; apiKey: string | null; numCtx: number; keepAlive: string; think: boolean; toolMode: 'native' | 'json' };
}

const EFFORTS = ['low', 'medium', 'high'] as const;

export function readConfig(env: Record<string, string | undefined>): AssistantConfig {
  const effort = env.ASSISTANT_EFFORT as (typeof EFFORTS)[number];
  const apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
  const geminiKey = env.GEMINI_API_KEY?.trim() || null;
  // on a hosting platform 127.0.0.1 is the platform's machine, not the one running Ollama:
  // there the address of a protected gateway must be given explicitly
  const hosted = Boolean(env.VERCEL);
  // A provider named in ASSISTANT_PROVIDER always wins. Otherwise: local development runs on a
  // local model (Ollama); the published site, which cannot reach a laptop, uses Gemini when its
  // key is set and no gateway to a local model is configured.
  const named = env.ASSISTANT_PROVIDER?.trim().toLowerCase();
  const provider: ProviderName =
    named === 'anthropic' || named === 'gemini' || named === 'ollama' ? named : hosted && geminiKey && !env.OLLAMA_BASE_URL?.trim() ? 'gemini' : 'ollama';
  const levels = ['minimal', 'low', 'medium', 'high'] as const;
  const level = env.GEMINI_THINKING_LEVEL?.trim().toLowerCase() as (typeof levels)[number];
  const baseUrl = env.OLLAMA_BASE_URL?.trim() || (hosted ? null : 'http://127.0.0.1:11434');
  const numCtx = Number(env.OLLAMA_NUM_CTX);
  const model = env.ASSISTANT_MODEL?.trim() || (provider === 'ollama' ? 'qwen3:8b' : provider === 'gemini' ? 'gemini-3.5-flash-lite' : 'claude-opus-5-5');
  // native tool calling is trusted only where it was verified (qwen3); other local models get
  // the schema-constrained JSON protocol unless told otherwise
  const mode = env.ASSISTANT_TOOL_MODE?.trim().toLowerCase();
  const toolMode = mode === 'native' || mode === 'json' ? mode : model.toLowerCase().startsWith('qwen3') ? 'native' : 'json';
  return {
    provider,
    model,
    configured: provider === 'ollama' ? baseUrl !== null : provider === 'gemini' ? geminiKey !== null : apiKey !== null,
    apiKey,
    effort: EFFORTS.includes(effort) ? effort : 'low',
    gemini: { apiKey: geminiKey, baseUrl: env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com', thinkingLevel: levels.includes(level) ? level : 'minimal' },
    ollama: { baseUrl, apiKey: env.OLLAMA_API_KEY?.trim() || null, numCtx: Number.isInteger(numCtx) && numCtx >= 2048 && numCtx <= 65536 ? numCtx : 8192, keepAlive: /^-?\d+[smh]?$/.test(env.OLLAMA_KEEP_ALIVE?.trim() ?? '') ? env.OLLAMA_KEEP_ALIVE!.trim() : '30m', think: env.ASSISTANT_THINK === '1', toolMode },
  };
}

export const USER_MESSAGES: Record<ErrorCode, string> = {
  not_configured: 'Ассистент ещё не подключён к языковой модели. Каталог и форма заявки на сайте работают как обычно.',
  rate_limited: 'Слишком много запросов подряд. Подождите минуту и повторите.',
  bad_request: 'Не удалось обработать сообщение. Сократите его и попробуйте ещё раз.',
  provider: 'Языковая модель сейчас недоступна. Попробуйте ещё раз чуть позже.',
  unavailable: 'Языковая модель не отвечает. Если это локальный запуск — проверьте, что Ollama запущен, и повторите.',
  timeout: 'Ответ занял слишком много времени. Попробуйте повторить запрос.',
  forbidden: 'Запрос отклонён.',
};

const STATUS: Record<ErrorCode, number> = { not_configured: 503, rate_limited: 429, bad_request: 400, provider: 502, unavailable: 503, timeout: 504, forbidden: 403 };

export function errorResponse(code: ErrorCode, headers: Record<string, string> = {}) {
  return Response.json({ error: code, message: USER_MESSAGES[code] }, { status: STATUS[code], headers: { 'Cache-Control': 'no-store', ...headers } });
}

/**
 * The assistant is same-origin only: browsers of other sites are turned away. This stops
 * cross-site use from a visitor's browser; it is not abuse protection — a script can omit
 * these headers, and for it only the limits below (and the provider's spend cap) apply.
 */
export function originAllowed(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Validates the body shape and size. Returns the turns to send to the model, or null. */
export function parseBody(body: unknown): ChatTurn[] | null {
  if (!body || typeof body !== 'object') return null;
  const list = (body as { messages?: unknown }).messages;
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.maxTurns) return null;
  const turns: ChatTurn[] = [];
  let total = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') return null;
    const { role, content } = m as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null;
    const text = content.trim();
    if (!text || text.length > (role === 'user' ? LIMITS.maxUserChars : LIMITS.maxAssistantChars)) return null;
    total += text.length;
    turns.push({ role, content: text });
  }
  if (total > LIMITS.maxTotalChars || turns[0].role !== 'user' || turns[turns.length - 1].role !== 'user') return null;
  return turns;
}

/**
 * Fixed-window limiter kept in the function instance's memory. It slows down a single
 * abusive client per warm instance; it is not a global quota (that needs a shared store).
 */
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): { ok: boolean; retryAfter: number } => {
    const t = now();
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
      // still full of live keys: drop the oldest so memory and the sweep stay bounded
      for (const k of hits.keys()) {
        if (hits.size <= 4000) break;
        hits.delete(k);
      }
    }
    const cur = hits.get(key);
    if (!cur || cur.reset <= t) {
      hits.set(key, { n: 1, reset: t + windowMs });
      return { ok: true, retryAfter: 0 };
    }
    cur.n++;
    return { ok: cur.n <= max, retryAfter: Math.ceil((cur.reset - t) / 1000) };
  };
}

export const clientKey = (request: Request) =>
  request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown';

export const encodeEvent = (event: ServerEvent) => `data: ${JSON.stringify(event)}\n\n`;

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no',
};

/**
 * Keeps the most recent turns that fit the model's context budget. The first kept turn is
 * always the visitor's, and the last (the current question) is never dropped.
 */
export function trimHistory(turns: ChatTurn[], maxChars: number): ChatTurn[] {
  let kept = turns;
  const size = (list: ChatTurn[]) => list.reduce((n, t) => n + t.content.length, 0);
  while (kept.length > 1 && size(kept) > maxChars) {
    kept = kept.slice(1);
    while (kept.length > 1 && kept[0].role !== 'user') kept = kept.slice(1);
  }
  return kept;
}
