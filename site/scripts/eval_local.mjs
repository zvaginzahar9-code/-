// Live check of the assistant against a real local model: runs the same five-step dialogue
// through the real request handler (server/handler.ts → Ollama → tools → catalogue) and
// prints what the model actually did. Nothing is mocked.
//   node scripts/eval_local.mjs qwen3:8b mistral:latest
import { readFileSync } from 'node:fs';
import { handle } from '../server/handler.ts';

const catalog = JSON.parse(readFileSync(new URL('../src/data/catalog.json', import.meta.url), 'utf8'));
const bySlug = new Map(catalog.map(t => [t.slug, t]));
const STEPS = ['Найди опоры для ЛЭП 110 кВ', 'Сравни два подходящих варианта', 'Покажи технические характеристики выбранной опоры', 'Открой раздел каталога', 'Подготовь заявку на выбранный товар'];
const EXPECT = [['search_catalog'], ['compare_towers'], ['get_tower_details'], ['go_to_section', 'filter_catalog'], ['prepare_inquiry']];
const models = process.argv.slice(2);
if (!models.length) models.push('qwen3:8b', 'mistral:latest');

async function turn(model, messages) {
  const t0 = Date.now();
  const res = await handle(new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) }), {
    env: { ASSISTANT_PROVIDER: 'ollama', ASSISTANT_MODEL: model, OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434', OLLAMA_API_KEY: process.env.OLLAMA_API_KEY, ASSISTANT_TOOL_MODE: process.env.ASSISTANT_TOOL_MODE },
    limit: () => ({ ok: true, retryAfter: 0 }),
  });
  if (!res.ok) return { error: `HTTP ${res.status} ${await res.text()}`, ms: Date.now() - t0 };
  const out = { text: '', tools: [], events: [], first: 0, notes: [] };
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const f of frames) {
      const e = JSON.parse(f.slice(6));
      if (e.t === 'retract') out.text = ''; // withdrawn by the server's fact check or as a preamble
      else if (e.t === 'text') {
        out.first ||= Date.now() - t0;
        out.text += e.d;
      } else if (e.t === 'status' && e.phase === 'tool') out.tools.push(e.label);
      else if (e.t !== 'status') out.events.push(e);
    }
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Marks and numbers the model wrote that the catalogue shown in this turn does not back up. */
function check(text, shown) {
  const problems = [];
  const marks = text.match(/\d?[А-ЯA-Z]{1,4}\d{2,3}-\d+[А-Яа-яA-Za-z+\d-]*/gu) ?? [];
  for (const m of new Set(marks)) if (!catalog.some(t => t.mark.toLowerCase() === m.toLowerCase())) problems.push(`марки «${m}» нет в каталоге`);
  const facts = new Set();
  for (const t of shown) for (const v of [t.H, t.h, t.L, t.mass, t.kv]) if (v != null) facts.add(String(v).replace('.', ','));
  for (const t of shown) for (const s of t.specs) for (const n of s.value.match(/\d+(?:[.,]\d+)?/g) ?? []) facts.add(n.replace('.', ','));
  for (const n of text.match(/\d+(?:[.,]\d+)?(?=\s*(?:м|кг|т)\b)/g) ?? []) {
    const norm = n.replace('.', ',').replace(/,0$/, '');
    if (![...facts].some(f => f.replace(/,0$/, '') === norm || f.replace(/\s/g, '') === norm)) problems.push(`число ${n} не из показанных записей`);
  }
  return problems;
}

for (const model of models) {
  console.log(`\n${'═'.repeat(70)}\n${model}\n${'═'.repeat(70)}`);
  const messages = [];
  const seen = []; // every catalogue record the tools have returned so far in this dialogue
  let pass = 0;
  for (let i = 0; i < STEPS.length; i++) {
    messages.push({ role: 'user', content: STEPS[i] });
    const r = await turn(model, messages);
    if (r.error) {
      console.log(`\n${i + 1}. ${STEPS[i]}\n   ОШИБКА: ${r.error}`);
      messages.pop();
      continue;
    }
    const kinds = r.events.map(e => (e.t === 'action' ? `action:${e.action.kind}` : e.t === 'error' ? `error:${e.code}` : e.t === 'done' ? `done:${e.stop}` : e.t));
    const shown = [];
    const notes = [];
    for (const e of r.events) {
      if (e.t === 'products') (shown.push(...e.items.map(x => bySlug.get(x.slug))), notes.push(e.items.length ? `Показаны карточки: ${e.items.map(x => x.mark).join(', ')}` : 'Поиск по каталогу ничего не нашёл'));
      if (e.t === 'details') (shown.push(bySlug.get(e.item.slug)), notes.push(`Показана карточка с характеристиками: ${e.item.mark}`));
      if (e.t === 'compare') (shown.push(...e.items.map(x => bySlug.get(x.slug))), notes.push(`Показана таблица сравнения: ${e.items.map(x => x.mark).join(', ')}`));
      if (e.t === 'action') notes.push(`Действие «${e.action.kind}» — выполнено на странице`);
      if (e.t === 'inquiry') notes.push(`Показан черновик заявки: ${e.draft.items.map(x => x.mark + (x.quantity ? ` ${x.quantity} шт.` : '')).join(', ') || 'без позиций'}; пользователь его пока не подтвердил`);
    }
    const called = r.events.filter(e => ['products', 'details', 'compare', 'action', 'inquiry'].includes(e.t)).map(e => (e.t === 'products' ? 'search_catalog' : e.t === 'details' ? 'get_tower_details' : e.t === 'compare' ? 'compare_towers' : e.t === 'inquiry' ? 'prepare_inquiry' : { section: 'go_to_section', filter: 'filter_catalog', open_tower: 'open_tower_sheet', compare: 'open_comparison' }[e.action.kind]));
    const ok = EXPECT[i].some(x => called.includes(x)) && !r.events.some(e => e.t === 'error');
    seen.push(...shown);
    const problems = check(r.text, seen);
    if (ok && !problems.length) pass++;
    console.log(`\n${i + 1}. ${STEPS[i]}`);
    console.log(`   инструменты: ${called.join(', ') || '— (не вызваны)'}  ${ok ? '✓' : '✗ ожидался ' + EXPECT[i].join(' / ')}`);
    console.log(`   события: ${kinds.join(' → ')}`);
    for (const e of r.events) {
      if (e.t === 'products') console.log(`   карточки: ${e.items.map(x => x.mark).join(', ')} (всего найдено ${e.total})`);
      if (e.t === 'compare') console.log(`   сравнение: ${e.items.map(x => x.mark).join(' / ')}, строк ${e.rows.length}`);
      if (e.t === 'details') console.log(`   характеристики: ${e.item.mark}, H=${e.item.H} м, масса=${e.item.mass} кг`);
      if (e.t === 'action') console.log(`   действие: ${JSON.stringify(e.action)}`);
      if (e.t === 'inquiry') console.log(`   черновик: ${JSON.stringify(e.draft)}`);
      if (e.t === 'error') console.log(`   ошибка: ${e.code}`);
    }
    console.log(`   время: первый текст ${r.first || '—'} мс, весь ход ${r.ms} мс`);
    console.log(`   достоверность: ${problems.length ? '✗ ' + problems.join('; ') : '✓ расхождений с каталогом не найдено'}`);
    console.log(`   ответ: ${r.text.replace(/\s+/g, ' ').slice(0, 420)}`);
    messages.push({ role: 'assistant', content: [r.text.trim(), ...notes.map(n => `[${n}]`)].filter(Boolean).join('\n').slice(0, 4000) || '[Ответ пуст]' });
  }
  console.log(`\nИТОГ ${model}: ${pass} из ${STEPS.length} шагов — нужный инструмент вызван и расхождений с каталогом нет`);
}
