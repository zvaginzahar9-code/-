import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '../server/orchestrator.ts';

/**
 * Scripted stand-in for the model. Used by the tests and by `ASSISTANT_FAKE=1 npm run dev`
 * to exercise the interface without credentials. It only picks tools by keyword — the tool
 * results and product data are still the real ones. It is never part of the deployed function.
 */

export type Step =
  | { text: string }
  | { tool: string; input: unknown; text?: string }
  | { stop: Anthropic.Message['stop_reason']; text?: string }
  | { throw: unknown };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted')); // like a real request, an aborted one does not go on
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
  });

function toMessage(step: Exclude<Step, { throw: unknown }>, n: number): Anthropic.Message {
  const content: unknown[] = [];
  if (step.text) content.push({ type: 'text', text: step.text, citations: null });
  let stop: Anthropic.Message['stop_reason'] = 'end_turn';
  if ('tool' in step) {
    content.push({ type: 'tool_use', id: `toolu_fake_${n}`, name: step.tool, input: step.input });
    stop = 'tool_use';
  } else if ('stop' in step) stop = step.stop;
  return { id: `msg_fake_${n}`, type: 'message', role: 'assistant', model: 'fake', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Message;
}

/** A client that replays `script(request)` and records every request it was sent. */
export function scriptedClient(script: (body: Anthropic.MessageStreamParams, call: number) => Step, delay = { think: 0, word: 0 }) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const client: ModelClient = {
    messages: {
      stream(body, options) {
        requests.push(structuredClone(body));
        const call = requests.length;
        const listeners: ((d: string) => void)[] = [];
        return {
          on(_event, listener) {
            listeners.push(listener);
            return this;
          },
          async finalMessage() {
            const step = script(body, call);
            if (delay.think) await sleep(delay.think, options?.signal);
            if ('throw' in step) throw step.throw;
            for (const word of (step.text ?? '').match(/\S+\s*/g) ?? []) {
              if (delay.word) await sleep(delay.word, options?.signal);
              listeners.forEach(l => l(word));
            }
            return toMessage(step, call);
          },
        };
      },
    },
  };
  return { client, requests };
}

const lastUserText = (body: Anthropic.MessageStreamParams) => {
  const last = body.messages[body.messages.length - 1];
  return typeof last.content === 'string' ? last.content : null;
};
const MARK = /(?:\d?[А-ЯA-Z]{1,4}\d{2,3}-\d+[А-Яа-яA-Za-z+\d-]*|ПБ\d+|Р2|У2[кт]?)/giu;

/** Keyword-driven demo script for running the interface locally without an API key. */
export function demoClient() {
  return scriptedClient(
    body => {
      const text = lastUserText(body);
      if (text === null) {
        // a tool result came back: wrap up
        const failed = JSON.stringify(body.messages[body.messages.length - 1].content).includes('"is_error":true');
        return {
          text: failed
            ? 'Не получилось: таких данных в каталоге нет. Уточните марку опоры — например, **П110-2**.'
            : 'Готово — результат на экране. Это демонстрационный сценарий без языковой модели: данные каталога настоящие, а текст ответа задан заранее.',
        };
      }
      const t = text.toLowerCase();
      const marks = text.match(MARK) ?? [];
      if (t.includes('ошибк')) return { throw: new Error('scripted provider failure') };
      if (t.includes('сравн') && marks.length >= 2) return { tool: 'compare_towers', input: { marks: marks.slice(0, 3) }, text: 'Сравниваю по данным каталога. ' };
      if (t.includes('заявк') || t.includes('расч')) {
        return { tool: 'prepare_inquiry', input: { items: marks.map(mark => ({ mark, quantity: Number(text.match(/(\d+)\s*шт/)?.[1]) || null })), note: marks.length ? null : text.slice(0, 200) } };
      }
      if ((t.includes('откр') || t.includes('чертёж') || t.includes('чертеж')) && marks.length) return { tool: 'open_tower_sheet', input: { mark: marks[0] }, text: `Открываю лист ${marks[0]}. ` };
      if (t.includes('производств')) return { tool: 'go_to_section', input: { section: 'production' }, text: 'Перехожу к разделу о производстве. ' };
      if (t.includes('контакт') || t.includes('телефон')) return { text: 'Телефон: **+7 777 684 60 70**. Адрес: Караганда, район Әлихан Бөкейхан, учётный квартал 018, здание 20, офис 35.' };
      if (marks.length === 1 && (t.includes('характеристик') || t.includes('подробн'))) return { tool: 'get_tower_details', input: { mark: marks[0] } };
      const kv = Number(text.match(/\b(35|110|220|330|500)\b/)?.[1]) || null;
      if (marks.length || kv || t.includes('опор')) {
        return { tool: 'search_catalog', input: { query: marks[0] ?? null, voltage_kv: marks.length ? null : kv, height_min_m: null, height_max_m: null, mass_max_kg: null, sort: null, limit: 4 }, text: 'Смотрю каталог. ' };
      }
      return {
        text: 'ТОО «Энергоконструкция» — завод металлоконструкций опор ЛЭП 35–750 кВ в Караганде.\n\nЯ могу:\n- найти опору по марке или классу напряжения;\n- сравнить две-три опоры;\n- открыть чертёжный лист;\n- подготовить черновик заявки на расчёт.',
      };
    },
    { think: 900, word: 45 },
  );
}
