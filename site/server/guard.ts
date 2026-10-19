import type { ChatTurn } from '../src/assistant/protocol.ts';
import { resolveTower } from './catalog.ts';
import { SYSTEM_PROMPT } from './prompt.ts';

/**
 * Deterministic checks around the model, so that honesty does not rest on the prompt alone.
 *
 *  sanitizeCall — before a tool runs: drops arguments the model added on its own (a filter or a
 *                 quantity the visitor never mentioned, a note that is not in the visitor's words).
 *  checkAnswer  — after the answer is written: finds statements that have no source in the tool
 *                 results, the conversation or the company facts. The orchestrator then withdraws
 *                 the answer and replaces it with a plain statement of what is and is not known.
 *
 * The checks aim for precision: each one looks for a specific, recognisable kind of unsupported
 * claim. They do not judge style or reasoning.
 */

const NUMBER = /\d(?:[\d   ]*\d)?(?:[.,]\d+)?/g;
const norm = (n: string) => String(parseFloat(n.replace(/[\s  ]/g, '').replace(',', '.')));

/** Every number that appears in the given texts, in one canonical spelling. */
function numbersIn(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.match(NUMBER) ?? []) {
      out.add(norm(m));
      // "24 000" is one number, but "110 2" is two: accept either reading
      for (const part of m.split(/[\s  ]+/)) out.add(norm(part));
    }
  }
  return out;
}

const userTexts = (history: ChatTurn[]) => history.filter(t => t.role === 'user').map(t => t.content);
const words = (s: string) => (s.toLowerCase().match(/[a-zа-яё]{4,}/g) ?? []).map(w => w.slice(0, 5));

export interface Sanitized {
  input: unknown;
  /** what was removed, told to the model so it does not speak as if the argument had been used */
  dropped: string[];
}

/** Removes arguments that have no basis in what the visitor (or the conversation) actually said. */
export function sanitizeCall(name: string, input: unknown, history: ChatTurn[]): Sanitized {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input, dropped: [] };
  const args: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const dropped: string[] = [];
  // only the visitor's own words count: a number the assistant wrote earlier does not make a filter requested
  const said = numbersIn(userTexts(history));
  // digits inside a tower mark ("П110-2") are not a quantity
  const saidByUser = numbersIn(userTexts(history).map(t => t.replace(MARK, ' ')));
  const need = (key: string, pool: Set<string>, why: string) => {
    const v = args[key];
    if (typeof v === 'number' && !pool.has(String(v))) {
      args[key] = null;
      dropped.push(`${key}: ${why}`);
    }
  };

  if (name === 'search_catalog' || name === 'filter_catalog') {
    need('voltage_kv', said, 'класс напряжения в разговоре не назывался, фильтр не применён');
    for (const key of ['height_min_m', 'height_max_m', 'mass_max_kg']) need(key, said, 'такое число в разговоре не называлось, условие не применено');
  }
  if (name === 'prepare_inquiry') {
    if (Array.isArray(args.items)) {
      args.items = args.items.map(item => {
        if (!item || typeof item !== 'object') return item;
        const it = { ...(item as Record<string, unknown>) };
        if (typeof it.quantity === 'number' && !saidByUser.has(String(it.quantity))) {
          it.quantity = null;
          dropped.push('quantity: пользователь не называл количество, оно оставлено пустым');
        }
        return it;
      });
    }
    if (typeof args.note === 'string' && args.note.trim()) {
      const mine = new Set(userTexts(history).flatMap(words));
      const noteWords = words(args.note);
      const known = noteWords.filter(w => mine.has(w)).length;
      if (!noteWords.length || known / noteWords.length < 0.6) {
        args.note = null;
        dropped.push('note: комментарий содержал сведения, которых пользователь не сообщал, и убран');
      }
    }
  }
  return { input: args, dropped };
}

export type ViolationKind = 'number' | 'mark' | 'price' | 'term' | 'stock' | 'contact' | 'submitted' | 'action' | 'internal';
export interface Violation {
  kind: ViolationKind;
  /** the offending fragment, for the log and the tests; never shown to the visitor */
  what: string;
}

export interface AnswerContext {
  text: string;
  history: ChatTurn[];
  /** raw tool results of this turn, as the model received them */
  toolResults: string[];
  /** page-action tools that failed this turn and did not later succeed */
  failedActions: string[];
}

const MARK = /\d?[А-ЯA-Z]{1,5}\d{2,3}-\d+[А-Яа-яA-Za-z]*(?:[+-][\dА-Яа-яA-Za-z,]+)*/gu;
const UNIT = '(?:м|метр[а-я]*|кг|килограмм[а-я]*|т(?!\\.[а-яё])|тонн[а-я]*|кВ|мм|см)(?![а-яёa-z\\d])';
const NUM = '\\d(?:[\\d\\u00a0\\u202f ]*\\d)?(?:[.,]\\d+)?';
const MEASURE = new RegExp(`(${NUM})\\s*${UNIT}`, 'gi');
/** the first number of a range: "20–25 м", "от 20 до 25 м" */
const RANGE_START = new RegExp(`(${NUM})\\s*(?:[-–—]|до)\\s*${NUM}\\s*${UNIT}`, 'gi');
const TOOL_NAMES = /\b(?:search_catalog|get_tower_details|compare_towers|open_tower_sheet|go_to_section|filter_catalog|open_comparison|prepare_inquiry)\b/;
const PROMPT_MARKS = ['ФОРМАТ ОТВЕТА', '<company', '<partners', '<unknown', 'СЕЙЧАС ТЫ ПИШЕШЬ ОТВЕТ', 'диспетчер ассистента', 'РЕЗУЛЬТАТ ИНСТРУМЕНТА', 'РЕЗУЛЬТАТЫ ИНСТРУМЕНТОВ'];
const COMPANY_PHONE = '77776846070';

/** Openings of the instruction lines (everything before the company facts): quoting one is a leak. */
const RULE_OPENINGS = SYSTEM_PROMPT.slice(0, SYSTEM_PROMPT.indexOf('<company'))
  .split('\n')
  .map(l => l.replace(/^[-\s]+/, '').trim())
  .filter(l => l.length >= 48)
  .map(l => l.slice(0, 44).toLowerCase());

/**
 * True as soon as the text starts quoting the instructions. Cheap enough to run on every streamed
 * piece, so a leak is cut off while it is being written instead of after a minute of generation.
 */
export function quotesInstructions(text: string): boolean {
  if (PROMPT_MARKS.some(m => text.includes(m))) return true;
  const lower = text.toLowerCase();
  return RULE_OPENINGS.some(o => lower.includes(o));
}

/** Finds statements in the answer that nothing in the tool results, the dialogue or the company facts supports. */
export function checkAnswer(c: AnswerContext): Violation[] {
  const found: Violation[] = [];
  const text = c.text.slice(0, 8000); // bounds the cost of the checks; answers are far shorter
  if (!text.trim()) return found;
  const sources = [...c.toolResults, ...c.history.map(t => t.content), SYSTEM_PROMPT];
  const sourceText = sources.join('\n');
  const known = numbersIn(sources);

  // measurements: a height, a mass, a voltage that no source contains
  for (const m of [...text.matchAll(MEASURE), ...text.matchAll(RANGE_START)]) {
    const value = norm(m[1]);
    const parts = m[1].split(/[\s  ]+/).map(norm);
    if (!known.has(value) && !parts.every(p => known.has(p))) found.push({ kind: 'number', what: m[0].trim() });
  }
  // tower marks that are neither in the catalogue nor quoted from the visitor or a tool result
  for (const m of new Set(text.match(MARK) ?? [])) {
    if (!resolveTower(m) && !sourceText.toLowerCase().includes(m.toLowerCase())) found.push({ kind: 'mark', what: m });
  }
  // prices and money: the sources have none
  const money = /\d[\d\s.,]*\s*(?:тенге|тг(?![а-яё])|₸|руб(?:\.|л[а-я]*)?(?![а-яё])|\$|usd|kzt|€|евро|долл[а-я]*)/i.exec(text);
  if (money) found.push({ kind: 'price', what: money[0].trim() });
  // lead times: the sources have none
  const term = /\d+\s*(?:[-–]\s*\d+\s*)?(?:рабоч[а-я]+\s+|календарн[а-я]+\s+)?(?:д(?:ень|ня|ней|нями|н\.)(?![а-яё])|сут(?:ок|ки)(?![а-яё])|недел[а-я]*|месяц[а-я]*)/i.exec(text);
  if (term && !sourceText.includes(term[0])) found.push({ kind: 'term', what: term[0].trim() });
  // stock: nothing in the sources says what is in the warehouse
  const stock = /(?:имеется|имеются|есть|доступн[аоы]?)\s+(?:сейчас\s+)?(?:в\s+наличии|на\s+складе)|(?:в\s+наличии|на\s+складе)\s+(?:сейчас\s+)?(?:есть|имеется|имеются|\d)/i.exec(text);
  if (stock && !/(?:нет|не)\s[^.]{0,40}$/i.test(text.slice(Math.max(0, stock.index - 40), stock.index))) found.push({ kind: 'stock', what: stock[0] });
  // contacts other than the one phone number the company has published
  const mail = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text);
  if (mail && !sourceText.includes(mail[0])) found.push({ kind: 'contact', what: mail[0] });
  const url = /https?:\/\/\S+|www\.\S+/i.exec(text);
  if (url && !sourceText.includes(url[0])) found.push({ kind: 'contact', what: url[0] });
  // phone numbers in the forms used in Kazakhstan and Russia; a run of specification figures is not one
  for (const p of text.match(/(?:\+7|(?<![\d,.])8)[\s(-]*\d{3,4}[\s)-]*\d{2,3}[\s-]*\d{2}[\s-]*\d{2}(?:[\s-]*\d{2})?/g) ?? []) {
    const digits = p.replace(/\D/g, '');
    if (!digits.endsWith(COMPANY_PHONE.slice(1)) && !sourceText.replace(/\D/g, '').includes(digits)) found.push({ kind: 'contact', what: p.trim() });
  }
  // the assistant cannot submit anything
  const sent = /(?<!не\s)(?<!не была\s)(?<!ничего не\s)заявк[а-я]*\s+(?:уже\s+|успешно\s+)?(?:отправлен|подан|принят|зарегистрирован|оформлен)[а-я]*/i.exec(text);
  if (sent && !/не\s+отправлен|ничего не отправлен/i.test(text.slice(Math.max(0, sent.index - 20), sent.index + sent[0].length))) found.push({ kind: 'submitted', what: sent[0] });
  const sentByMe = /(?<!не\s)(?:отправил[аи]?|передал[аи]?|оформил[аи]?)\s+(?:вашу\s+|эту\s+)?заявк/i.exec(text);
  if (sentByMe && !sent) found.push({ kind: 'submitted', what: sentByMe[0] });
  // a page action that failed must not be described as done
  if (c.failedActions.length) {
    const done = /(?<!не\s)(?<!не удалось\s)(?<!не могу\s)(?:открыва[юе]м?|открыл[аи]?|открыт[аоы]?|перехожу|переш[её]л|перешли|показываю чертёж)(?![а-яё])/i.exec(text);
    if (done) found.push({ kind: 'action', what: done[0] });
  }
  // internal names and pieces of the instructions
  const tool = TOOL_NAMES.exec(text);
  if (tool) found.push({ kind: 'internal', what: tool[0] });
  for (const mark of PROMPT_MARKS) if (text.includes(mark)) found.push({ kind: 'internal', what: mark });
  const lower = text.toLowerCase();
  const quoted = RULE_OPENINGS.find(o => lower.includes(o));
  if (quoted) found.push({ kind: 'internal', what: quoted });
  return found;
}

/** What the visitor reads instead of an answer that failed the check: only what is certain. */
export function safeAnswer(violations: Violation[], shown: { cards: boolean; failedAction: boolean }): string {
  const kinds = new Set(violations.map(v => v.kind));
  const parts: string[] = [];
  if (shown.failedAction || kinds.has('action')) parts.push('Выполнить это действие не удалось.');
  if (kinds.has('mark')) parts.push('Такой марки в каталоге нет.');
  if (kinds.has('price') || kinds.has('term')) parts.push('Цен и сроков изготовления в каталоге нет — их считают по заявке; телефон +7 777 684 60 70.');
  if (kinds.has('stock')) parts.push('Сведений о наличии на складе у меня нет — уточните по телефону +7 777 684 60 70 или в заявке.');
  if (kinds.has('contact')) parts.push('Из контактов у меня есть только телефон компании: +7 777 684 60 70.');
  if (kinds.has('submitted')) parts.push('Заявку я не отправляю: её отправляете вы через форму на сайте.');
  if (kinds.has('number')) parts.push(shown.cards ? 'Точные характеристики — в карточках выше: они взяты из каталога.' : 'Подтверждённых данных для точного ответа у меня нет. Назовите марку опоры или класс напряжения — покажу характеристики из каталога.');
  if (!parts.length) parts.push('На этот вопрос у меня нет подтверждённого ответа. Спросите об опорах из каталога или о компании.');
  return parts.join(' ');
}
