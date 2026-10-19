import { scrollToEl } from '../core/smooth';
import { $ } from '../core/env';
import { SECTIONS, VOLTAGES, type InquiryDraft, type UiAction } from './protocol';

/**
 * Executes the page commands the assistant asks for. Every command arrives already
 * validated by the server; here it is carried out through the site's own controls and
 * the real outcome is reported back, so the chat never claims an action that did not happen.
 */

export interface ActionContext {
  /** loads the catalogue chunk (lineup, sheet, comparison) if it is not on the page yet */
  loadCatalog(): Promise<void>;
  /** gets the panel out of the way so the visitor sees the page */
  minimize(): void;
  /** true on layouts where the panel covers the page */
  covers(): boolean;
}

export interface ActionResult {
  ok: boolean;
  /** what happened, for the chip in the chat and for the model's next turn */
  label: string;
}

const SECTION_LABEL = { top: 'начало страницы', production: 'раздел «Производство»', catalog: 'каталог опор', items: 'раздел «Изделия»', experience: 'раздел «Опыт»', request: 'форма заявки', contacts: 'контакты' } as const;

const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

export function describe(action: UiAction): string {
  switch (action.kind) {
    case 'open_tower':
      return `Чертёжный лист ${action.mark}`;
    case 'section':
      return `Переход: ${SECTION_LABEL[action.section]}`;
    case 'filter':
      return `Каталог: ${[action.kv ? `${action.kv} кВ` : 'все классы', action.query ? `«${action.query}»` : '', action.view === 'table' ? 'таблица' : action.view === 'line' ? 'линейка' : ''].filter(Boolean).join(', ')}`;
    case 'compare':
      return `Сравнение: ${action.marks.join(', ')}`;
  }
}

export async function perform(action: UiAction, ctx: ActionContext): Promise<ActionResult> {
  const label = describe(action);
  try {
    switch (action.kind) {
      case 'section': {
        // the server validates these too; nothing outside the known lists reaches a selector
        const target = SECTIONS.includes(action.section) ? $(`#${action.section}`) : null;
        if (!target) return { ok: false, label };
        if (ctx.covers()) ctx.minimize();
        scrollToEl(target);
        return { ok: true, label };
      }
      case 'open_tower': {
        await ctx.loadCatalog();
        const [{ openSheet }, { lineupNode }, { bySlug }] = await Promise.all([import('../catalog/sheet'), import('../catalog/catalog'), import('../catalog/data')]);
        if (!bySlug.has(action.slug)) return { ok: false, label };
        ctx.minimize();
        const cmp = $('[data-cmp]');
        if (cmp && !cmp.hidden) $<HTMLButtonElement>('[data-cmp-close]')?.click();
        openSheet(action.slug, lineupNode(action.slug)?.querySelector('img') ?? null);
        await nextFrame();
        const sheet = $('[data-sheet]');
        return { ok: !!sheet && !sheet.hidden && $('[data-sheet-mark]')?.textContent === action.mark, label };
      }
      case 'filter': {
        if (action.kv !== null && !VOLTAGES.includes(action.kv as (typeof VOLTAGES)[number])) return { ok: false, label };
        if (action.view !== null && action.view !== 'line' && action.view !== 'table') return { ok: false, label };
        await ctx.loadCatalog();
        const root = $('[data-catalog]');
        const kvBtn = root && $<HTMLButtonElement>(`[data-kv-btn="${action.kv ?? 0}"]`, root);
        const search = root && $<HTMLInputElement>('[data-search]', root);
        if (!root || !kvBtn || !search) return { ok: false, label };
        if (ctx.covers()) ctx.minimize();
        if (action.view) $<HTMLButtonElement>(`[data-view="${action.view}"]`, root)?.click();
        if (kvBtn.getAttribute('aria-selected') !== 'true') kvBtn.click();
        const q = action.query ?? '';
        if (search.value !== q) {
          search.value = q;
          search.dispatchEvent(new Event('input', { bubbles: true }));
        }
        scrollToEl(root);
        return { ok: true, label };
      }
      case 'compare': {
        await ctx.loadCatalog();
        const [{ compareSet, toggleCompare }, { bySlug }] = await Promise.all([import('../catalog/compare'), import('../catalog/data')]);
        if (action.slugs.length < 2 || !action.slugs.every(s => bySlug.has(s))) return { ok: false, label };
        const sheet = $('[data-sheet]');
        if (sheet && !sheet.hidden) {
          $<HTMLButtonElement>('[data-sheet-close]')?.click();
          // the sheet releases the scroll lock and focus when its closing animation ends: wait for that
          for (let i = 0; i < 40 && !sheet.hidden; i++) await new Promise(r => setTimeout(r, 50));
          if (!sheet.hidden) return { ok: false, label };
        }
        $<HTMLButtonElement>('[data-compare-clear]')?.click();
        for (const slug of action.slugs) toggleCompare(slug);
        if (compareSet.size !== action.slugs.length) return { ok: false, label };
        ctx.minimize();
        $<HTMLButtonElement>('[data-compare-open]')?.click();
        await nextFrame();
        const box = $('[data-cmp]');
        return { ok: !!box && !box.hidden, label };
      }
    }
  } catch {
    return { ok: false, label };
  }
}

export const draftText = (draft: InquiryDraft) =>
  [...draft.items.map(i => `Опора ${i.mark} — ${i.quantity == null ? 'количество: ' : `${i.quantity} шт.`}`), draft.note ?? ''].filter(Boolean).join('\n');

/**
 * Puts a confirmed draft into the site's request form. This only fills the message field:
 * the visitor still enters their contacts and presses «Отправить запрос» themselves.
 */
export function applyDraft(draft: InquiryDraft, ctx: ActionContext): boolean {
  const field = $<HTMLTextAreaElement>('[data-form-message]');
  const form = $<HTMLFormElement>('[data-form]');
  if (!field || !form) return false;
  const text = draftText(draft);
  if (!field.value.includes(text)) field.value = field.value.trim() ? `${field.value.trim()}\n${text}` : text;
  ctx.minimize();
  scrollToEl('#request');
  // focus the first contact field once the scroll has had time to start
  setTimeout(() => (form.elements.namedItem('name') as HTMLInputElement | null)?.focus({ preventScroll: true }), 900);
  return true;
}
