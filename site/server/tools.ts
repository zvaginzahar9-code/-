import type Anthropic from '@anthropic-ai/sdk';
import { SECTIONS, VOLTAGES, type SectionId, type ServerEvent } from '../src/assistant/protocol.ts';
import { compareTowers, resolveTower, searchCatalog, suggest, toDetails, type SearchInput } from './catalog.ts';

/**
 * The assistant's tools. Each one is read-only against the catalogue or produces a
 * UI command for the visitor's own page; none can write data, call the network or
 * submit the request form. Inputs come from the model and are validated here.
 */

export interface ToolOutcome {
  /** what the model reads back */
  result: unknown;
  isError?: boolean;
  /** what the visitor's page receives */
  events?: ServerEvent[];
}

interface ToolSpec {
  definition: Anthropic.Tool;
  /** short status line shown while the tool runs */
  label: string;
  run(input: Record<string, unknown>): ToolOutcome;
}

const fail = (message: string, extra: Record<string, unknown> = {}): ToolOutcome => ({ result: { error: message, ...extra }, isError: true });

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const num = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const isNullish = (v: unknown) => v === null || v === undefined;

const nullable = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, 'null'], ...extra });
const object = (properties: Record<string, unknown>): Anthropic.Tool['input_schema'] => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Resolves 2–3 distinct marks; reports the ones that are not in the catalogue. */
function resolveMany(input: unknown) {
  if (!Array.isArray(input) || input.length < 2 || input.length > 3) return { error: fail('Нужно от 2 до 3 марок опор.') };
  const found = [];
  const unknown: string[] = [];
  for (const ref of input) {
    const t = typeof ref === 'string' ? resolveTower(ref) : null;
    if (t) found.push(t);
    else unknown.push(String(ref).slice(0, 40));
  }
  if (unknown.length) {
    return { error: fail('Этих марок нет в каталоге.', { unknown, similar: Object.fromEntries(unknown.map(u => [u, suggest(u)])) }) };
  }
  const unique = [...new Map(found.map(t => [t.slug, t])).values()];
  if (unique.length < 2) return { error: fail('Для сравнения нужны разные опоры.') };
  return { towers: unique };
}

const SECTION_NAMES: Record<SectionId, string> = {
  top: 'начало страницы',
  production: 'Производство',
  catalog: 'Каталог опор',
  items: 'Изделия: мачты, молниеотводы, порталы, опоры контактной сети, узлы',
  experience: 'Опыт',
  request: 'Заявка на расчёт',
  contacts: 'Контакты',
};

const SHOWN = 'Эти данные уже показаны пользователю на экране карточками. Не перечисляй характеристики заново: ответь одним-двумя предложениями по сути вопроса.';
const UI_NOTE = 'Команда передана странице пользователя. Итог выполнения виден пользователю в интерфейсе.';

const specs: ToolSpec[] = [
  {
    label: 'Ищу в каталоге',
    definition: {
      name: 'search_catalog',
      description:
        'Ищет опоры в каталоге сайта и показывает найденные пользователю карточками. Вызывай, когда нужно подобрать опоры по марке, классу напряжения, высоте или массе, или когда пользователь называет марку неточно. query сопоставляется с маркой опоры, маркой провода, номером типового проекта и текстом характеристик. Возвращает до limit записей и общее число подходящих (total).',
      input_schema: object({
        query: nullable('string', { description: 'Марка или её часть («П110», «У220-2»), марка провода («АС-150») либо номер типового проекта. null — без текстового условия.' }),
        voltage_kv: nullable('integer', { enum: [...VOLTAGES, null], description: 'Класс напряжения, кВ.' }),
        height_min_m: nullable('number', { description: 'Минимальная высота опоры H, м.' }),
        height_max_m: nullable('number', { description: 'Максимальная высота опоры H, м.' }),
        mass_max_kg: nullable('number', { description: 'Максимальная масса опоры с цинком, кг.' }),
        sort: nullable('string', { enum: ['height_asc', 'height_desc', 'mass_asc', 'mass_desc', null], description: 'Сортировка; null — по порядку каталога.' }),
        limit: nullable('integer', { description: 'Сколько записей вернуть, 1–12. null — 6.' }),
      }),
    },
    run(input) {
      const voltage = input.voltage_kv;
      if (!isNullish(voltage) && !VOLTAGES.includes(voltage as (typeof VOLTAGES)[number])) {
        return fail('В каталоге нет такого класса напряжения.', { available_kv: VOLTAGES });
      }
      const sort = input.sort;
      const sorts = ['height_asc', 'height_desc', 'mass_asc', 'mass_desc'];
      if (!isNullish(sort) && !sorts.includes(sort as string)) return fail('Неизвестная сортировка.');
      for (const key of ['height_min_m', 'height_max_m', 'mass_max_kg', 'limit'] as const) {
        if (!isNullish(input[key]) && num(input[key], 0, 1e6) === null) return fail(`Некорректное значение ${key}.`);
      }
      if (!isNullish(input.query) && (typeof input.query !== 'string' || input.query.length > 80)) return fail('Запрос слишком длинный или некорректный: нужна марка, провод или номер проекта.');
      const args: SearchInput = {
        query: str(input.query, 80),
        voltage_kv: (voltage as number | null) ?? null,
        height_min_m: num(input.height_min_m, 0, 1e6),
        height_max_m: num(input.height_max_m, 0, 1e6),
        mass_max_kg: num(input.mass_max_kg, 0, 1e6),
        sort: (sort as SearchInput['sort']) ?? null,
        limit: num(input.limit, 1, 12),
      };
      const { items, total } = searchCatalog(args);
      if (!total) {
        return { result: { total: 0, items: [], hint: 'Ничего не найдено. Сообщи об этом пользователю и предложи ослабить условия.' }, events: [{ t: 'products', items: [], total: 0 }] };
      }
      return { result: { total, shown: items.length, items: items.map(({ image, ...rest }) => rest), how_to_answer: SHOWN }, events: [{ t: 'products', items, total }] };
    },
  },
  {
    label: 'Открываю характеристики',
    definition: {
      name: 'get_tower_details',
      description:
        'Возвращает полную таблицу характеристик одной опоры из каталога и показывает её пользователю развёрнутой карточкой. Вызывай перед тем, как называть характеристики конкретной опоры.',
      input_schema: object({ mark: { type: 'string', description: 'Марка опоры, например «П110-2».' } }),
    },
    run(input) {
      const ref = str(input.mark, 40);
      const t = ref ? resolveTower(ref) : null;
      if (!t) return fail('Такой марки нет в каталоге.', { similar: ref ? suggest(ref) : [] });
      const item = toDetails(t);
      const { image, ...forModel } = item;
      return { result: { ...forModel, how_to_answer: SHOWN }, events: [{ t: 'details', item }] };
    },
  },
  {
    label: 'Сравниваю опоры',
    definition: {
      name: 'compare_towers',
      description:
        'Сравнивает 2–3 опоры по всем характеристикам каталога и показывает пользователю таблицу сравнения в чате. В values значение null означает, что характеристика в каталоге не указана.',
      input_schema: object({ marks: { type: 'array', items: { type: 'string' }, description: 'От 2 до 3 марок опор.' } }),
    },
    run(input) {
      const r = resolveMany(input.marks);
      if (r.error) return r.error;
      const { items, rows } = compareTowers(r.towers);
      return {
        result: { marks: items.map(i => i.mark), rows, notes: items.filter(i => i.note).map(i => ({ mark: i.mark, note: i.note })), how_to_answer: 'Таблица сравнения уже показана пользователю. Не пересказывай её: назови одним-двумя предложениями главные отличия.' },
        events: [{ t: 'compare', items, rows }],
      };
    },
  },
  {
    label: 'Открываю чертёжный лист',
    definition: {
      name: 'open_tower_sheet',
      description:
        'Открывает на сайте чертёжный лист опоры: чертёж с размерами и таблица характеристик на весь экран. Вызывай, когда пользователь просит открыть, показать чертёж или перейти к конкретной опоре.',
      input_schema: object({ mark: { type: 'string', description: 'Марка опоры.' } }),
    },
    run(input) {
      const ref = str(input.mark, 40);
      const t = ref ? resolveTower(ref) : null;
      if (!t) return fail('Такой марки нет в каталоге — лист не открыт.', { similar: ref ? suggest(ref) : [] });
      return { result: { status: UI_NOTE, opening: t.mark }, events: [{ t: 'action', action: { kind: 'open_tower', slug: t.slug, mark: t.mark } }] };
    },
  },
  {
    label: 'Перехожу к разделу',
    definition: {
      name: 'go_to_section',
      description:
        'Прокручивает страницу к разделу сайта: production — производство и оборудование, catalog — линейка опор ЛЭП, items — изделия: прожекторные мачты, молниеотводы, порталы ОРУ, опоры контактной сети, детали свайных фундаментов, траверсы и другие металлоконструкции 0,4–35 кВ, experience — опыт партнёра по ВЛ в Казахстане, request — форма заявки на расчёт, contacts — адрес и телефон, top — начало страницы.',
      input_schema: object({ section: { type: 'string', enum: [...SECTIONS] } }),
    },
    run(input) {
      const section = input.section as SectionId;
      if (!SECTIONS.includes(section)) return fail('Такого раздела на сайте нет.', { available: SECTIONS });
      return { result: { status: UI_NOTE, section: SECTION_NAMES[section] }, events: [{ t: 'action', action: { kind: 'section', section } }] };
    },
  },
  {
    label: 'Настраиваю каталог',
    definition: {
      name: 'filter_catalog',
      description:
        'Переходит к каталогу на странице сайта и применяет его фильтры: класс напряжения, поиск по марке, вид «линейка» или «таблица». Вызывай только когда пользователь прямо просит открыть, показать или отфильтровать сам каталог на странице. На просьбы найти, подобрать или показать опоры отвечай через search_catalog — он показывает карточки в чате. Поиск в каталоге сайта работает только по марке.',
      input_schema: object({
        voltage_kv: nullable('integer', { enum: [...VOLTAGES, null], description: 'null — все классы.' }),
        mark_query: nullable('string', { description: 'Часть марки; null — без поиска.' }),
        view: nullable('string', { enum: ['line', 'table', null], description: 'null — не менять вид.' }),
      }),
    },
    run(input) {
      const kv = input.voltage_kv;
      if (!isNullish(kv) && !VOLTAGES.includes(kv as (typeof VOLTAGES)[number])) return fail('В каталоге нет такого класса напряжения.', { available_kv: VOLTAGES });
      const view = input.view;
      if (!isNullish(view) && view !== 'line' && view !== 'table') return fail('Неизвестный вид каталога.');
      if (!isNullish(input.mark_query) && typeof input.mark_query !== 'string') return fail('Некорректный запрос.');
      const query = str(input.mark_query, 40);
      const matching = searchCatalog({ query: null, voltage_kv: (kv as number | null) ?? null, height_min_m: null, height_max_m: null, mass_max_kg: null, sort: null, limit: 1 }).total;
      return {
        result: { status: UI_NOTE, towers_in_voltage_class: matching },
        events: [{ t: 'action', action: { kind: 'filter', kv: (kv as number | null) ?? null, query, view: (view as 'line' | 'table' | null) ?? null } }],
      };
    },
  },
  {
    label: 'Открываю сравнение',
    definition: {
      name: 'open_comparison',
      description:
        'Открывает на сайте полноэкранное сравнение 2–3 опор: силуэты в общем масштабе и таблица различий. Вызывай, когда пользователь просит открыть сравнение на странице; для сравнения прямо в чате используй compare_towers.',
      input_schema: object({ marks: { type: 'array', items: { type: 'string' }, description: 'От 2 до 3 марок опор.' } }),
    },
    run(input) {
      const r = resolveMany(input.marks);
      if (r.error) return r.error;
      const marks = r.towers.map(t => t.mark);
      return { result: { status: UI_NOTE, comparing: marks }, events: [{ t: 'action', action: { kind: 'compare', slugs: r.towers.map(t => t.slug), marks } }] };
    },
  },
  {
    label: 'Готовлю черновик заявки',
    definition: {
      name: 'prepare_inquiry',
      description:
        'Показывает пользователю черновик заявки на расчёт: список опор с количеством и комментарий. Ничего не отправляет: пользователь сам переносит черновик в форму на сайте, вписывает контакты и отправляет. Вызывай, когда пользователь хочет запросить расчёт или коммерческое предложение.',
      input_schema: object({
        items: {
          type: 'array',
          description: 'Опоры для расчёта. Может быть пустым, если пользователь ещё не выбрал марки.',
          items: object({ mark: { type: 'string' }, quantity: nullable('integer', { description: 'Количество, шт. Только если пользователь сам назвал число; иначе null. Не подставляй 1.' }) }),
        },
        note: nullable('string', { description: 'Комментарий со слов пользователя: объект, регион, класс ВЛ. Без личных данных.' }),
      }),
    },
    run(input) {
      if (!Array.isArray(input.items) || input.items.length > 12) return fail('В заявке может быть до 12 позиций.');
      const items = [];
      const unknown: string[] = [];
      for (const raw of input.items as Record<string, unknown>[]) {
        const ref = str(raw?.mark, 40);
        const t = ref ? resolveTower(ref) : null;
        if (!t) {
          unknown.push(String(raw?.mark).slice(0, 40));
          continue;
        }
        const q = raw.quantity;
        if (!isNullish(q) && (num(q, 1, 100000) === null || !Number.isInteger(q))) return fail(`Некорректное количество для ${t.mark}.`);
        items.push({ slug: t.slug, mark: t.mark, quantity: (q as number | null) ?? null });
      }
      if (unknown.length) return fail('Этих марок нет в каталоге — черновик не создан.', { unknown, similar: Object.fromEntries(unknown.map(u => [u, suggest(u)])) });
      if (!isNullish(input.note) && typeof input.note !== 'string') return fail('Некорректный комментарий.');
      const note = typeof input.note === 'string' ? input.note.trim().slice(0, 600) || null : null;
      if (!items.length && !note) return fail('Черновик пуст: нужна хотя бы одна опора или комментарий.');
      return {
        result: {
          status: 'Черновик показан пользователю. В форму он попадёт только после нажатия «Перенести в форму»; заявку отправляет сам пользователь.',
          items: items.map(({ mark, quantity }) => ({ mark, quantity })),
          note,
        },
        events: [{ t: 'inquiry', draft: { items, note } }],
      };
    },
  },
];

const byName = new Map(specs.map(s => [s.definition.name, s]));

export const toolDefinitions: Anthropic.Tool[] = specs.map(s => s.definition);
export const toolLabel = (name: string) => byName.get(name)?.label ?? 'Обрабатываю запрос';

/** Runs one tool call. Never throws: failures come back as an error result for the model. */
export function runTool(name: string, input: unknown): ToolOutcome {
  const spec = byName.get(name);
  if (!spec) return fail('Такого инструмента нет.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Аргументы инструмента должны быть объектом.');
  try {
    return spec.run(input as Record<string, unknown>);
  } catch (e) {
    console.error(JSON.stringify({ evt: 'assistant_tool_error', tool: name, name: e instanceof Error ? e.name : 'unknown' }));
    return fail('Инструмент не сработал. Сообщи пользователю, что данные сейчас недоступны.');
  }
}
