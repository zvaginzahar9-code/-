import { fmt } from '../core/env';
import type { CompareRow, InquiryDraft, ProductCard, ProductDetails } from './protocol';

/** Markup for the rich blocks inside an answer. All values come from catalogue records. */

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const ICON = {
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M12.5 6l6 6-6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="18" height="11"/><path d="M7 10.5h.01M11 10.5h.01M15 10.5h.01M8 14h8"/></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  min: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6 6 6-6M12 3v17"/></svg>',
  fresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11"/><path d="M15.5 8.5v-4h-11v11h4"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  fail: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg>',
};

const mass = (m: number | null) => (m == null ? null : `${m.toLocaleString('ru-RU')} кг`);
const metres = (v: number | null, digits = 1) => (v == null ? null : `${fmt(v, digits)} м`);
const cell = (v: string | null) => (v == null ? '<dd class="is-none">нет данных</dd>' : `<dd>${esc(v)}</dd>`);

export function productCard(p: ProductCard | ProductDetails, selected: boolean): string {
  const specs = 'specs' in p ? p.specs.filter(s => s.label !== 'Наименование изделия') : null;
  return `
<article class="pc" data-slug="${esc(p.slug)}" data-mark="${esc(p.mark)}">
  <button class="pc__draw" type="button" data-pc-open tabindex="-1" aria-label="Открыть чертёжный лист опоры ${esc(p.mark)}">
    <img src="${esc(p.image)}" alt="" loading="lazy" decoding="async">
  </button>
  <div class="pc__body">
    <p class="pc__kv">Стальная опора ВЛ ${p.kv} кВ</p>
    <h3 class="pc__mark">${esc(p.mark)}</h3>
    <dl class="pc__keys">
      <div><dt>Высота H</dt>${cell(metres(p.H))}</div>
      <div><dt>Масса с цинком</dt>${cell(mass(p.mass))}</div>
      <div><dt>База L</dt>${cell(metres(p.L, 2))}</div>
    </dl>
    ${p.note ? `<p class="pc__note">${esc(p.note)}</p>` : ''}
    ${specs ? '' : `<p class="pc__meta">${[p.wire ? `Провод: ${esc(p.wire)}` : '', p.project ? `Типовой проект ${esc(p.project)}` : 'Типовой проект в каталоге не указан'].filter(Boolean).join(' · ')}</p>`}
  </div>
  ${specs ? `<table class="pc__specs"><tbody>${specs.map(s => `<tr><th scope="row">${esc(s.label)}</th><td>${esc(s.value)}</td></tr>`).join('')}</tbody></table>` : ''}
  <div class="pc__acts pc__foot">
    <button type="button" class="chip chip--solid" data-pc-open aria-label="Чертёж ${esc(p.mark)}">Чертёж ${ICON.arrow}</button>
    <button type="button" class="chip" data-pc-compare aria-pressed="${selected}" aria-label="Сравнить ${esc(p.mark)}">Сравнить</button>
    <button type="button" class="chip" data-pc-inquiry aria-label="В заявку ${esc(p.mark)}">В заявку</button>
  </div>
</article>`;
}

export function productList(items: ProductCard[], total: number, selected: (slug: string) => boolean): string {
  if (!items.length) {
    return `<div class="empty"><p class="empty__t">В каталоге ничего не найдено</p><p>По этим условиям опор нет. Попробуйте изменить класс напряжения, высоту или марку.</p></div>`;
  }
  const more = total > items.length ? `<p class="plist-more">Показано ${items.length} из ${total} подходящих. Уточните запрос или откройте каталог на странице.</p>` : '';
  return `<div class="pcs">${items.map(p => productCard(p, selected(p.slug))).join('')}</div>${more}`;
}

export function comparison(items: ProductCard[], rows: CompareRow[]): string {
  const maxH = Math.max(...items.map(i => i.H));
  const figures = items
    .map(i => `<figure><img src="${esc(i.image)}" alt="" style="height:${Math.round((i.H / maxH) * 92)}px"><figcaption><b>${esc(i.mark)}</b><span>${fmt(i.H)} м</span></figcaption></figure>`)
    .join('');
  const body = rows
    .map(r => `<tr class="${r.differs ? 'is-diff' : ''}"><th scope="row">${esc(r.label)}${r.differs ? '<span class="sr"> — отличается</span>' : ''}</th>${r.values.map(v => (v == null ? '<td class="is-none">нет данных</td>' : `<td>${esc(v)}</td>`)).join('')}</tr>`)
    .join('');
  const notes = items.filter(i => i.note).map(i => `<p class="pc__note"><b>${esc(i.mark)}.</b> ${esc(i.note)}</p>`).join('');
  return `
<div class="cmpc" data-slugs="${esc(items.map(i => i.slug).join(','))}" data-marks="${esc(items.map(i => i.mark).join('|'))}">
  <div class="cmpc__stage" aria-hidden="true">${figures}</div>
  <div class="cmpc__scroll" tabindex="0" role="region" aria-label="Таблица сравнения: ${esc(items.map(i => i.mark).join(', '))}">
    <table>
      <thead><tr><th><span class="sr">Параметр</span></th>${items.map(i => `<th scope="col">${esc(i.mark)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <p class="cmpc__legend"><i></i>отличия выделены</p>
  ${notes}
  <div class="pc__acts"><button type="button" class="chip chip--solid" data-cmp-page>Открыть сравнение на странице ${ICON.arrow}</button></div>
</div>`;
}

export function inquiryCard(draft: InquiryDraft): string {
  const items = draft.items.length
    ? `<ul class="inq__items">${draft.items.map(i => `<li><b>${esc(i.mark)}</b><span>${i.quantity == null ? 'количество не указано' : `${i.quantity.toLocaleString('ru-RU')} шт.`}</span></li>`).join('')}</ul>`
    : '';
  return `
<div class="inq" data-inq>
  <p class="inq__t">Черновик заявки на расчёт</p>
  ${items}
  ${draft.note ? `<p class="inq__note">${esc(draft.note)}</p>` : ''}
  <p class="inq__hint" data-inq-hint>Ничего не отправлено. Черновик попадёт в форму на сайте только после вашего подтверждения; имя и телефон вы укажете в форме сами.</p>
  <div class="pc__acts">
    <button type="button" class="chip chip--signal" data-inq-apply>Перенести в форму</button>
    <button type="button" class="chip" data-inq-cancel>Отменить</button>
  </div>
</div>`;
}
