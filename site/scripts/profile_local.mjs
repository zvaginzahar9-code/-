// Where does a turn's time go, and what does the model cost in memory?
// Runs a few fixed requests through the real handler against a local model and prints, for
// every request to the model server: wall time, time to first output, model load, prompt
// evaluation (tokens, speed), generation (tokens, speed); plus tool execution times and
// memory (RAM committed by the model process, VRAM, free commit) before and after.
//
//   node scripts/profile_local.mjs qwen3:8b          (COLD=1 also measures a cold start)
import { execFileSync } from 'node:child_process';
import { handle } from '../server/handler.ts';

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
const model = process.argv[2] ?? 'qwen3:8b';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ps(cmd) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
export async function memory() {
  const loaded = (await (await fetch(`${BASE}/api/ps`)).json()).models ?? [];
  const os = ps('$o=Get-CimInstance Win32_OperatingSystem; "$([int]($o.FreeVirtualMemory/1KB)) $([int]($o.FreePhysicalMemory/1KB))"').split(' ').map(Number);
  const llama = ps("(Get-Process llama-server -ErrorAction SilentlyContinue | ForEach-Object { [int]($_.PrivateMemorySize64/1MB) }) -join '+'");
  let vram = '';
  try {
    vram = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim();
  } catch {
    /* no NVIDIA GPU */
  }
  return {
    loaded: loaded.map(m => `${m.name} ${(m.size / 2 ** 30).toFixed(1)} ГБ (VRAM ${(m.size_vram / 2 ** 30).toFixed(1)} ГБ, ctx ${m.context_length})`).join('; ') || '—',
    names: loaded.map(m => m.name),
    commitFreeMB: os[0] || null,
    ramFreeMB: os[1] || null,
    modelProcessMB: llama || '0',
    vramUsedMB: vram || null,
  };
}
const fmtMem = m => `загружено: ${m.loaded} | процесс модели (commit): ${m.modelProcessMB} МБ | VRAM занято: ${m.vramUsedMB} МБ | свободно RAM ${m.ramFreeMB} МБ, свободно commit ${m.commitFreeMB} МБ`;

/** Unloads every model except `keep` (or all of them) and waits until the server reports it done. */
export async function unloadOthers(keep) {
  for (let i = 0; i < 20; i++) {
    const { models = [] } = await (await fetch(`${BASE}/api/ps`)).json();
    const extra = models.filter(m => m.name !== keep);
    if (!extra.length) return;
    for (const m of extra) await fetch(`${BASE}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }) }).then(r => r.text());
    await sleep(700);
  }
}

async function turn(messages) {
  const t0 = Date.now();
  let report = null;
  const realLog = console.log;
  console.log = line => {
    try {
      const j = JSON.parse(line);
      if (j.evt === 'assistant_turn') report = j;
    } catch {
      /* not ours */
    }
  };
  const res = await handle(new Request('http://local/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) }), {
    env: { ASSISTANT_PROVIDER: 'ollama', ASSISTANT_MODEL: model, OLLAMA_BASE_URL: BASE, ASSISTANT_TOOL_MODE: process.env.ASSISTANT_TOOL_MODE, OLLAMA_NUM_CTX: process.env.OLLAMA_NUM_CTX, ASSISTANT_THINK: process.env.ASSISTANT_THINK },
    limit: () => ({ ok: true, retryAfter: 0 }),
  });
  let text = '';
  let firstText = 0;
  let firstEvent = 0;
  const events = [];
  let buf = '';
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop();
    for (const f of frames) {
      const e = JSON.parse(f.slice(6));
      if (e.t === 'retract') (text = ''), (firstText = 0);
      else if (e.t === 'text') (firstText ||= Date.now() - t0), (text += e.d);
      else if (e.t !== 'status') (firstEvent ||= Date.now() - t0), events.push(e.t === 'error' ? `error:${e.code}` : e.t);
    }
  }
  console.log = realLog;
  return { ms: Date.now() - t0, firstText, firstEvent, text, events, report };
}

function show(title, r) {
  console.log(`\n▸ ${title}`);
  console.log(`  весь ход ${r.ms} мс | первая карточка/действие на экране ${r.firstEvent || '—'} мс | первый текст ответа ${r.firstText || '—'} мс | события: ${r.events.join(', ')} | ответ ${r.text.length} симв.`);
  for (const s of r.report?.steps ?? []) {
    if (s.step === 'tool') console.log(`    инструмент ${s.name}: ${s.ms} мс`);
    else {
      const other = Math.max(0, s.ms - s.loadMs - s.promptMs - s.genMs);
      console.log(`    запрос к модели [${s.step}]: ${s.ms} мс = загрузка ${s.loadMs} + разбор промпта ${s.promptMs} (${s.inTokens} ток.${s.promptMs > 50 ? `, ${Math.round((s.inTokens / s.promptMs) * 1000)} ток/с` : ', из кэша'}) + генерация ${s.genMs} (${s.outTokens} ток., ${s.genMs ? Math.round((s.outTokens / s.genMs) * 1000) : 0} ток/с) + прочее ${other}; до первого вывода ${s.firstMs} мс`);
    }
  }
  return r;
}

const isMain = process.argv[1]?.endsWith('profile_local.mjs');
if (isMain) {
  console.log(`Модель: ${model}`);
  console.log(`до начала — ${fmtMem(await memory())}`);
  await unloadOthers(process.env.COLD ? null : model);
  if (process.env.COLD) {
    await sleep(1500);
    console.log(`после выгрузки всех моделей — ${fmtMem(await memory())}`);
    show('ХОЛОДНЫЙ СТАРТ: «Какой у вас телефон?» (модель не в памяти)', await turn([{ role: 'user', content: 'Какой у вас телефон?' }]));
    console.log(`  после загрузки — ${fmtMem(await memory())}`);
  }
  show('без инструмента: «Какой у вас телефон?»', await turn([{ role: 'user', content: 'Какой у вас телефон?' }]));
  const search = show('инструмент + ответ: «Найди опоры для ЛЭП 110 кВ»', await turn([{ role: 'user', content: 'Найди опоры для ЛЭП 110 кВ' }]));
  show('то же ещё раз (промпт в кэше модели)', await turn([{ role: 'user', content: 'Найди опоры для ЛЭП 110 кВ' }]));
  show('инструмент + ответ: «Покажи характеристики П110-2»', await turn([{ role: 'user', content: 'Покажи характеристики П110-2' }]));
  show('инструмент + ответ: «Сравни П110-2 и У110-2»', await turn([{ role: 'user', content: 'Сравни П110-2 и У110-2' }]));
  show('действие на странице: «Открой раздел каталога»', await turn([{ role: 'user', content: 'Открой раздел каталога' }]));
  show('второй ход диалога: «А теперь только те, что ниже 25 метров»', await turn([
    { role: 'user', content: 'Найди опоры для ЛЭП 110 кВ' },
    { role: 'assistant', content: `${search.text.trim().slice(0, 3000)}\n[Показаны карточки: 1П110-6, 1У110-1, 1У110-2, 1У110-3, 1У110-4, 1У110-4П (из 44 найденных)]` },
    { role: 'user', content: 'А теперь только те, что ниже 25 метров' },
  ]));
  console.log(`\nпосле прогона — ${fmtMem(await memory())}`);
}
