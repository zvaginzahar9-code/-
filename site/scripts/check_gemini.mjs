// A real check of the Gemini integration: sends requests to the actual API through the same
// request handler the site uses, and prints what came back. Run it with your key in the
// environment — the key is read by the server code only and is never printed:
//
//   GEMINI_API_KEY=<key> node scripts/check_gemini.mjs            (PowerShell: $env:GEMINI_API_KEY='<key>'; node scripts/check_gemini.mjs)
//   ASSISTANT_MODEL=gemini-3.1-flash-lite GEMINI_API_KEY=<key> node scripts/check_gemini.mjs
//
// It makes about eight requests to the API (well inside the free tier's per-minute limits).
import { handle } from '../server/handler.ts';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set in this shell. Nothing was sent.');
  process.exit(2);
}
const env = { ASSISTANT_PROVIDER: 'gemini', GEMINI_API_KEY: process.env.GEMINI_API_KEY, ASSISTANT_MODEL: process.env.ASSISTANT_MODEL, GEMINI_THINKING_LEVEL: process.env.GEMINI_THINKING_LEVEL };

async function turn(messages, overrides = {}) {
  const t0 = Date.now();
  let report = null;
  const realLog = console.log;
  const realErr = console.error;
  console.log = line => {
    try {
      const j = JSON.parse(line);
      if (j.evt === 'assistant_turn') report = j;
    } catch {
      /* not ours */
    }
  };
  console.error = line => {
    try {
      const j = JSON.parse(line);
      if (j.evt === 'assistant_error') report = j;
    } catch {
      /* not ours */
    }
  };
  const res = await handle(new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) }), { env: { ...env, ...overrides }, limit: () => ({ ok: true, retryAfter: 0 }) });
  const out = { status: res.status, text: '', chunks: 0, firstMs: 0, events: [], report: null };
  if (res.ok) {
    let buf = '';
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop();
      for (const f of frames) {
        const e = JSON.parse(f.slice(6));
        if (e.t === 'retract') out.text = '';
        else if (e.t === 'text') (out.firstMs ||= Date.now() - t0), out.chunks++, (out.text += e.d);
        else if (e.t !== 'status') out.events.push(e);
      }
    }
  } else out.events.push({ t: 'http', code: (await res.json()).error });
  console.log = realLog;
  console.error = realErr;
  out.ms = Date.now() - t0;
  out.report = report;
  return out;
}

const kinds = r => r.events.map(e => (e.t === 'action' ? `action:${e.action.kind}` : e.t === 'error' ? `error:${e.code}` : e.t === 'done' ? `done:${e.stop}` : e.t === 'http' ? `http:${e.code}` : e.t)).join(' → ');
let failed = 0;
function check(name, r, ok, extra = '') {
  if (!ok) failed++;
  console.log(`\n${ok ? '✓' : '✗'} ${name}`);
  console.log(`   ${r.ms} мс${r.firstMs ? `, первый текст через ${r.firstMs} мс, текст пришёл ${r.chunks} частями` : ''} | события: ${kinds(r)}${extra ? ` | ${extra}` : ''}`);
  if (r.report?.steps) console.log(`   шаги: ${r.report.steps.map(s => (s.step === 'tool' ? `${s.name}` : `модель ${s.ms} мс (${s.inTokens}→${s.outTokens} ток.)`)).join(', ')}`);
  if (r.report?.evt === 'assistant_error') console.log(`   журнал ошибки: code=${r.report.code} status=${r.report.status ?? '—'} detail=${r.report.detail ?? '—'}`);
  if (r.text) console.log(`   ответ: ${r.text.replace(/\s+/g, ' ').slice(0, 260)}`);
}
const has = (r, t) => r.events.some(e => e.t === t);
const done = r => r.events.at(-1)?.t === 'done';

console.log(`Модель: ${env.ASSISTANT_MODEL ?? 'gemini-3.5-flash-lite (по умолчанию)'}`);

let r = await turn([{ role: 'user', content: 'Какой у вас телефон и адрес?' }]);
check('ответ без инструмента, потоком', r, done(r) && r.text.includes('684') && !r.events.some(e => e.t === 'error'), r.chunks > 1 ? 'потоковая передача подтверждена' : 'текст пришёл одним куском');

r = await turn([{ role: 'user', content: 'Найди опоры для ЛЭП 110 кВ' }]);
const products = r.events.find(e => e.t === 'products');
check('function calling: поиск по каталогу', r, done(r) && !!products && products.items.every(i => i.kv === 110), products ? `карточки: ${products.items.map(i => i.mark).join(', ')} (найдено ${products.total})` : 'search_catalog не вызван');
const history = [
  { role: 'user', content: 'Найди опоры для ЛЭП 110 кВ' },
  { role: 'assistant', content: `${r.text}\n[Показаны карточки: ${products?.items.map(i => i.mark).join(', ') ?? ''}]` },
];

r = await turn([...history, { role: 'user', content: 'А теперь только те, что ниже 25 метров' }]);
const refined = r.events.find(e => e.t === 'products');
check('контекст: уточнение вторым сообщением', r, done(r) && !!refined && refined.items.every(i => i.kv === 110 && i.H <= 25), refined ? `найдено ${refined.total}` : 'поиск не повторён');

r = await turn([{ role: 'user', content: 'Сравни П110-2, У110-2 и ПС110-9В' }]);
check('function calling: сравнение трёх опор', r, done(r) && r.events.find(e => e.t === 'compare')?.items.length === 3);

r = await turn([{ role: 'user', content: 'Открой чертёж П110-2' }]);
check('действие на странице: чертёжный лист', r, done(r) && r.events.some(e => e.t === 'action' && e.action.kind === 'open_tower' && e.action.slug === 'p110-2'));

r = await turn([{ role: 'user', content: 'Подготовь заявку на П110-2, 40 штук' }]);
const draft = r.events.find(e => e.t === 'inquiry')?.draft;
check('подготовка заявки', r, done(r) && draft?.items[0]?.mark === 'П110-2' && draft.items[0].quantity === 40, draft ? JSON.stringify(draft.items) : 'черновик не создан');

r = await turn([{ role: 'user', content: 'Открой чертёж опоры П999-9' }]);
check('ошибка инструмента: несуществующая марка', r, done(r) && !has(r, 'action'));

r = await turn([{ role: 'user', content: 'Сколько стоит П110-2 и за сколько дней изготовите?' }]);
check('вопрос без ответа в данных: цена и срок', r, done(r) && !/\d\s*(тенге|₸|руб|дн)/i.test(r.text));

r = await turn([{ role: 'user', content: 'Привет' }], { GEMINI_API_KEY: 'AIza-deliberately-wrong-key' });
check('обработка ошибки: неверный ключ', r, r.events.at(-1)?.t === 'error' && r.events.at(-1).code === 'not_configured' && !has(r, 'done'));

console.log(`\n${failed ? `НЕ ПРОЙДЕНО: ${failed}` : 'Все проверки пройдены на настоящем API.'}`);
process.exit(failed ? 1 : 0);
