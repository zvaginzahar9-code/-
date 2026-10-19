import { describe, expect, it, vi } from 'vitest';
import { STATUS, createMachine, isBusy, next, type Signal, type State } from '../src/assistant/machine';
import { renderBlocks, toPlain } from '../src/assistant/markdown';
import type { ProductCard, ServerEvent } from '../src/assistant/protocol';
import { parseEvents, sendTurn } from '../src/assistant/stream';

const frame = (e: ServerEvent) => `data: ${JSON.stringify(e)}\n\n`;

describe('interaction states', () => {
  const walk = (signals: Signal[], from: State = 'idle') => signals.reduce<State[]>((path, s) => [...path, next(path.at(-1)!, s)], [from]);

  it('follows the voice round trip: idle → listening → processing → responding → speaking → idle', () => {
    expect(walk(['LISTEN_START', 'SPEECH_END', 'SUBMIT', 'FIRST_TEXT', 'DONE', 'SPEAK_START', 'SPEAK_END'])).toEqual(['idle', 'listening', 'transcribing', 'processing', 'responding', 'idle', 'speaking', 'idle']);
  });

  it('goes back to processing while a tool runs between two pieces of text', () => {
    expect(walk(['SUBMIT', 'FIRST_TEXT', 'WORKING', 'FIRST_TEXT', 'DONE'])).toEqual(['idle', 'processing', 'responding', 'processing', 'responding', 'idle']);
  });

  it('has the alternative endings: error, interrupted speech, cancelled listening', () => {
    expect(walk(['SUBMIT', 'FAIL'])).toEqual(['idle', 'processing', 'error']);
    expect(walk(['SUBMIT', 'FIRST_TEXT', 'FAIL']).at(-1)).toBe('error');
    expect(walk(['SUBMIT', 'FIRST_TEXT', 'CANCEL']).at(-1)).toBe('idle');
    expect(walk(['SPEAK_START', 'LISTEN_START'])).toEqual(['idle', 'speaking', 'listening']);
    expect(walk(['LISTEN_START', 'LISTEN_CANCEL'])).toEqual(['idle', 'listening', 'idle']);
    expect(walk(['LISTEN_FAIL'])).toEqual(['idle', 'error']);
    expect(walk(['LISTEN_START', 'SPEECH_END', 'LISTEN_CANCEL']).at(-1)).toBe('idle');
  });

  it('recovers from an error by any new attempt', () => {
    expect(next('error', 'SUBMIT')).toBe('processing');
    expect(next('error', 'LISTEN_START')).toBe('listening');
    expect(next('error', 'RESET')).toBe('idle');
  });

  it('never shows an activity without its cause', () => {
    // no state claims the model is answering, or audio is playing, unless that really started
    for (const s of Object.keys(STATUS) as State[]) {
      if (s !== 'processing') expect(next(s, 'FIRST_TEXT')).toBe(s);
      if (s !== 'idle' && s !== 'error') expect(next(s, 'SPEAK_START')).toBe(s);
    }
    expect(next('idle', 'DONE')).toBe('idle');
    expect(next('idle', 'SPEAK_END')).toBe('idle');
    expect(next('idle', 'SPEECH_END')).toBe('idle');
  });

  it('every busy state has a way out, so nothing can stay stuck', () => {
    const exits: Record<string, Signal[]> = { listening: ['LISTEN_CANCEL', 'LISTEN_FAIL'], transcribing: ['LISTEN_CANCEL', 'LISTEN_FAIL'], processing: ['DONE', 'FAIL', 'CANCEL'], responding: ['DONE', 'FAIL', 'CANCEL'], speaking: ['SPEAK_END'] };
    for (const [state, signals] of Object.entries(exits)) for (const s of signals) expect(['idle', 'error']).toContain(next(state as State, s));
    for (const s of Object.keys(STATUS) as State[]) expect(next(s, 'RESET')).toBe('idle');
  });

  it('reports changes once and ignores signals that do not apply', () => {
    const seen: string[] = [];
    const m = createMachine((state, prev) => seen.push(`${prev}>${state}`));
    m.send('DONE');
    m.send('SUBMIT');
    m.send('SUBMIT');
    m.send('FIRST_TEXT');
    m.send('DONE');
    expect(seen).toEqual(['idle>processing', 'processing>responding', 'responding>idle']);
    expect(isBusy('processing') && isBusy('responding') && !isBusy('speaking') && !isBusy('idle')).toBe(true);
  });
});

describe('answer rendering', () => {
  it('renders paragraphs, lists, bold and code', () => {
    expect(renderBlocks('Нашёл **две** опоры:\n- П110-2\n- У110-2\n\nМарка `П110-2`.')).toEqual(['<p>Нашёл <b>две</b> опоры:</p>', '<ul><li>П110-2</li><li>У110-2</li></ul>', '<p>Марка <code>П110-2</code>.</p>']);
    expect(renderBlocks('1. Первое\n2. Второе')).toEqual(['<ol><li>Первое</li><li>Второе</li></ol>']);
    expect(renderBlocks('строка один\nстрока два')).toEqual(['<p>строка один<br>строка два</p>']);
  });

  it('never lets model output become markup', () => {
    const html = renderBlocks('<img src=x onerror=alert(1)>\n- <script>alert(2)</script>\n[ссылка](javascript:alert(3)) **<b onclick=x>жирный</b>**').join('');
    expect(html).not.toMatch(/<(img|script|a)\b/i);
    expect(html).not.toMatch(/<b onclick/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;');
  });

  it('keeps an unfinished stream readable', () => {
    expect(renderBlocks('Сравниваю **П110')).toEqual(['<p>Сравниваю **П110</p>']);
    expect(renderBlocks('')).toEqual([]);
    expect(renderBlocks('## Заголовок\nтекст')).toEqual(['<p>Заголовок<br>текст</p>']);
  });

  it('gives speech and the clipboard plain text', () => {
    expect(toPlain('**Телефон:** `+7 777`\n- пункт')).toBe('Телефон: +7 777\nпункт');
  });
});

describe('event stream', () => {
  it('parses events split at any byte boundary', () => {
    const all = frame({ t: 'status', phase: 'thinking' }) + frame({ t: 'text', d: 'Опора П110-2' }) + frame({ t: 'done', stop: 'end' });
    for (let cut = 1; cut < all.length; cut += 7) {
      const a = parseEvents(all.slice(0, cut));
      const b = parseEvents(a.rest + all.slice(cut));
      expect([...a.events, ...b.events].map(e => e.t)).toEqual(['status', 'text', 'done']);
      expect(b.rest).toBe('');
    }
  });

  it('drops a malformed frame and keeps the rest', () => {
    const { events } = parseEvents(`data: {broken\n\n: comment\n\n${frame({ t: 'text', d: 'ок' })}`);
    expect(events).toEqual([{ t: 'text', d: 'ок' }]);
  });

  const respond = (body: string | null, init: ResponseInit = {}) => vi.fn(async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;
  const run = (f: typeof fetch, signal = new AbortController().signal) => {
    const got: ServerEvent[] = [];
    return sendTurn([{ role: 'user', content: 'q' }], { fetch: f, signal, onEvent: e => got.push(e) }).then(end => ({ end, got }));
  };

  it('is complete only after the server says done', async () => {
    const ok = await run(respond(frame({ t: 'text', d: 'a' }) + frame({ t: 'done', stop: 'end' })));
    expect(ok.end).toEqual({ ok: true });
    expect(ok.got.map(e => e.t)).toEqual(['text', 'done']);
    const cut = await run(respond(frame({ t: 'text', d: 'a' })));
    expect(cut.end).toMatchObject({ ok: false, aborted: false, code: 'incomplete' });
  });

  it('decodes multi-byte text split across network chunks', async () => {
    const bytes = new TextEncoder().encode(frame({ t: 'text', d: 'Привет, Қарағанды' }) + frame({ t: 'done', stop: 'end' }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3));
        c.close();
      },
    });
    const f = (async () => new Response(stream)) as unknown as typeof fetch;
    const { got } = await run(f);
    expect(got[0]).toEqual({ t: 'text', d: 'Привет, Қарағанды' });
  });

  it('reports server and transport failures with a user-safe message', async () => {
    const error = await run(respond(frame({ t: 'text', d: 'a' }) + frame({ t: 'error', code: 'provider', message: 'Языковая модель сейчас недоступна.' })));
    expect(error.end).toEqual({ ok: false, aborted: false, code: 'provider', message: 'Языковая модель сейчас недоступна.' });
    expect((await run(respond(JSON.stringify({ error: 'rate_limited', message: 'Подождите минуту.' }), { status: 429 }))).end).toMatchObject({ code: 'rate_limited', message: 'Подождите минуту.' });
    expect((await run(respond('<html>502</html>', { status: 502 }))).end).toMatchObject({ ok: false, code: 'provider' });
    expect((await run(respond(JSON.stringify({ error: 'not_configured' }), { status: 503 }))).end).toMatchObject({ code: 'not_configured' });
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect((await run(offline)).end).toMatchObject({ ok: false, aborted: false, code: 'network' });
  });

  it('distinguishes the visitor stopping from a timeout', async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    const abort = new AbortController();
    const stopped = run(hang, abort.signal);
    abort.abort();
    expect((await stopped).end).toMatchObject({ ok: false, aborted: true });
    const timedOut = await sendTurn([{ role: 'user', content: 'q' }], { fetch: hang, signal: new AbortController().signal, onEvent() {}, timeoutMs: 20 });
    expect(timedOut).toMatchObject({ ok: false, aborted: false, code: 'timeout' });
  });
});

describe('product blocks', () => {
  const load = async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), innerWidth: 1280, devicePixelRatio: 1 });
    return import('../src/assistant/views');
  };
  const card: ProductCard = { slug: 'p110-2', mark: 'П110-2', kv: 110, H: 31, h: 19, L: null, mass: null, wire: null, project: null, image: 'catalog/p110-2-t.webp' };

  it('shows a missing value as missing, not as a number', async () => {
    const { productCard } = await load();
    const html = productCard(card, false);
    expect(html.match(/нет данных/g)).toHaveLength(2);
    expect(html).toContain('Типовой проект в каталоге не указан');
    expect(html).not.toMatch(/null|undefined|NaN/);
  });

  it('escapes every value it prints', async () => {
    const { productCard, comparison, inquiryCard, productList } = await load();
    const evil = '"><img src=x onerror=alert(1)>';
    const bad = { ...card, mark: evil, slug: evil, wire: evil, project: evil, note: evil, image: evil };
    const html =
      productCard({ ...bad, specs: [{ label: evil, value: evil }] }, true) +
      productList([bad], 3, () => false) +
      comparison([bad, bad], [{ label: evil, values: [evil, null], differs: true }]) +
      inquiryCard({ items: [{ slug: evil, mark: evil, quantity: 2 }], note: evil });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toMatch(/"><img/);
  });

  it('has an explicit empty state and a count of what was left out', async () => {
    const { productList } = await load();
    expect(productList([], 0, () => false)).toContain('В каталоге ничего не найдено');
    expect(productList([card], 44, () => false)).toContain('Показано 1 из 44');
  });

  it('asks for confirmation in the inquiry draft and says nothing was sent', async () => {
    const { inquiryCard } = await load();
    const html = inquiryCard({ items: [{ slug: 'p110-2', mark: 'П110-2', quantity: 40 }, { slug: 'u110-2', mark: 'У110-2', quantity: null }], note: null });
    expect(html).toContain('Ничего не отправлено');
    expect(html).toContain('data-inq-apply');
    expect(html).toContain('количество не указано');
  });
});
