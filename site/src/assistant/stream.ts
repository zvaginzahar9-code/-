import type { ChatTurn, ErrorCode, ServerEvent } from './protocol';

/** Splits a server-sent-events buffer into complete events; `rest` is the unfinished tail. */
export function parseEvents(buffer: string): { events: ServerEvent[]; rest: string } {
  const events: ServerEvent[] = [];
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  for (const frame of frames) {
    const data = frame
      .split('\n')
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const event = JSON.parse(data);
      if (event && typeof event.t === 'string') events.push(event);
    } catch {
      /* a malformed frame is dropped; the turn ends with whatever arrived intact */
    }
  }
  return { events, rest };
}

const FALLBACK: Record<ErrorCode | 'network' | 'incomplete', string> = {
  not_configured: 'Ассистент ещё не подключён к языковой модели.',
  rate_limited: 'Слишком много запросов подряд. Подождите минуту и повторите.',
  bad_request: 'Не удалось обработать сообщение. Сократите его и попробуйте ещё раз.',
  provider: 'Языковая модель сейчас недоступна. Попробуйте ещё раз чуть позже.',
  unavailable: 'Языковая модель не отвечает. Попробуйте ещё раз чуть позже.',
  timeout: 'Ответ занял слишком много времени. Попробуйте повторить запрос.',
  forbidden: 'Запрос отклонён.',
  network: 'Нет связи с сервером. Проверьте соединение и повторите.',
  incomplete: 'Связь прервалась, ответ получен не полностью.',
};

export interface TurnHandlers {
  onEvent(event: ServerEvent): void;
  signal: AbortSignal;
  /** injected in tests */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** How a turn ended, as far as the browser can tell. */
export type TurnEnd = { ok: true } | { ok: false; aborted: boolean; code: ErrorCode | 'network' | 'incomplete'; message: string };

/**
 * Sends the conversation and feeds events to `onEvent` as they arrive. Resolves once:
 * `ok` only after the server's `done` event — a stream that just stops is reported as incomplete.
 */
export async function sendTurn(messages: ChatTurn[], h: TurnHandlers): Promise<TurnEnd> {
  const failure = (code: ErrorCode | 'network' | 'incomplete', message?: string): TurnEnd => ({ ok: false, aborted: false, code, message: message || FALLBACK[code] });
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), h.timeoutMs ?? 300_000);
  const stop = () => timeout.abort();
  h.signal.addEventListener('abort', stop, { once: true });
  try {
    const res = await (h.fetch ?? fetch)('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: timeout.signal,
    });
    if (!res.ok || !res.body) {
      let code: ErrorCode = res.status === 429 ? 'rate_limited' : res.status === 503 ? 'not_configured' : res.status === 400 ? 'bad_request' : 'provider';
      let message: string | undefined;
      try {
        const body = await res.json();
        if (typeof body?.error === 'string' && body.error in FALLBACK) code = body.error;
        if (typeof body?.message === 'string') message = body.message;
      } catch {
        /* not JSON: keep the status-based code */
      }
      return failure(code, message);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let end: TurnEnd | null = null;
    try {
      read: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseEvents(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.t === 'error') end = failure(event.code, event.message);
          else if (event.t === 'done') end = { ok: true };
          try {
            h.onEvent(event);
          } catch {
            // the page could not show this event: stop rather than present a partial answer as whole
            end = failure('incomplete');
            break read;
          }
        }
      }
    } finally {
      // if the turn did not run to its end, stop the server generating into nothing
      void reader.cancel().catch(() => {});
    }
    return end ?? failure('incomplete');
  } catch {
    if (h.signal.aborted) return { ok: false, aborted: true, code: 'incomplete', message: '' };
    return failure(timeout.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
    h.signal.removeEventListener('abort', stop);
  }
}
