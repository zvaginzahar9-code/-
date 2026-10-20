import raw from '../data/products.json';
import { gsap, lockScroll, scrollToEl } from '../core/smooth';
import { $, $$, isNarrow, reducedMotion } from '../core/env';
import { esc, normMark } from './text';
import { prefillRequest } from '../ui/form';

/**
 * Product catalogue beyond the LEP towers: masts, lightning rods, ОРУ portals, contact-network
 * supports, pile-foundation parts and 0.4–35 kV hardware. Data: scripts/build_products.py;
 * drawings: 1:1 vector redraws (scripts/trace_items.py) in public/products/.
 */
export interface Cell { t: string; rs?: number; cs?: number }
export interface Item {
  slug: string;
  name: string;
  mark: string;
  /** drawing file stem in public/products, or null when the source has no scheme */
  draw: string | null;
  /** the drawing is the scheme of the whole series (shared by several marks) */
  series: boolean;
  /** "scheme": a drawing redrawn 1:1; "picture": the product redrawn from its photo/3D model */
  drawKind?: 'scheme' | 'picture' | 'sheet' | null;
  /** "<base>+N" marks: the sheet is the base pole's (the same pole on a stand) */
  base?: string;
  /** for drawKind "sheet": the typical series album the sheet comes from */
  sheet?: { series: string; title: string; url: string };
  note: string;
  tables: Cell[][][];
  /** stated by the source unambiguously; doc = drawing, album or series number */
  keys: { mass?: number; H?: number; doc?: string };
}
export interface Group { id: string; title: string; items: Item[] }
export interface Category { id: string; title: string; groups: Group[] }

export const categories = (raw as unknown as { categories: Category[] }).categories;
interface Entry { item: Item; group: Group; cat: Category }
const all: Entry[] = categories.flatMap(cat => cat.groups.flatMap(group => group.items.map(item => ({ item, group, cat }))));
export const itemBySlug = new Map(all.map(e => [e.item.slug, e]));

const PAGE = 48;
const state = { cat: categories[0].id, group: '', q: '', limit: PAGE };
let list: Entry[] = [];

// typical-series sheets are cleaned scans (raster); everything else is a vector redraw
const drawSrc = (it: Item) => `products/${it.draw}.${it.drawKind === 'sheet' ? 'webp' : 'svg'}`;
/** light raster preview of the same drawing for the cards (scripts/thumbs.cjs) */
const thumbSrc = (it: Item) => `products/${it.draw}-s.webp`;
const num = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const massLabel = (m?: number) => (m == null ? '' : `${num(m)} кг`);

function visible(): Entry[] {
  if (state.q) return all.filter(e => normMark(e.item.mark).includes(state.q) || normMark(e.item.name).includes(state.q));
  return all.filter(e => e.cat.id === state.cat && (!state.group || e.group.id === state.group));
}

/**
 * For a mark with no drawing anywhere: its data from the catalogue, set like the title block of a
 * drawing (mark, mass, album/drawing number, height, or the first row of its table). Nothing invented.
 */
function passport(it: Item, max: number, group = ''): [string, string][] {
  const rows: [string, string][] = [];
  if (group) rows.push(['Группа', group]);
  if (it.keys.mass != null) rows.push(['Масса', `${num(it.keys.mass)} кг`]);
  if (it.keys.H != null) rows.push(['Высота', `${num(it.keys.H)} м`]);
  if (it.keys.doc) rows.push(['Чертёж / альбом', it.keys.doc]);
  const t = it.tables[0];
  if (t && t.length > 1) {
    t[0].forEach((h, k) => {
      const v = t[1][k]?.t;
      if (k > 0 && v && v !== '—' && !/масса|вес|высота|чертеж|чертёж|альбом/i.test(h.t)) rows.push([h.t, v]);
    });
  }
  return rows.slice(0, max);
}
const passportHtml = (it: Item, max: number, cls: string, group = '') =>
  `<span class="${cls}"><span class="pass__k">Паспорт изделия</span><b>${esc(it.mark)}</b>${passport(it, max, group)
    .map(([k, v]) => `<span class="pass__r"><span>${esc(k)}</span><span>${esc(v)}</span></span>`)
    .join('')}</span>`;

function card(e: Entry, i: number, showGroup: boolean) {
  const it = e.item;
  const fig = it.draw ? `<img src="${thumbSrc(it)}" alt="" loading="lazy" decoding="async">` : passportHtml(it, 3, 'pass', e.group.title);
  const meta = [massLabel(it.keys.mass), it.keys.H ? `H ${num(it.keys.H)} м` : ''].filter(Boolean).join(' · ');
  return `<li style="--i:${i % PAGE}"><button class="it" type="button" data-item="${esc(it.slug)}" aria-label="${esc(it.name)} — открыть лист">
    <span class="it__draw">${fig}</span>
    <span class="it__stamp"><b>${esc(it.mark)}</b>${meta ? `<span>${esc(meta)}</span>` : ''}</span>
    ${it.keys.doc ? `<span class="it__doc">Чертёж ${esc(it.keys.doc)}</span>` : ''}
    ${showGroup ? `<span class="it__group">${esc(e.group.title)}</span>` : ''}
  </button></li>`;
}

export function initItems() {
  const root = $('[data-items]');
  if (!root) return;
  const tabs = $('[data-items-tabs]', root)!;
  const groupsEl = $('[data-items-groups]', root)!;
  const grid = $('[data-items-grid]', root)!;
  const more = $<HTMLButtonElement>('[data-items-more]', root)!;
  const shown = $('[data-items-shown]', root)!;
  const search = $<HTMLInputElement>('[data-items-search]', root)!;
  $('[data-items-total]', root)!.textContent = String(all.length);

  tabs.innerHTML = categories
    .map(c => `<button role="tab" type="button" aria-selected="${c.id === state.cat}" data-cat="${c.id}">${esc(c.title)}<sup>${c.groups.reduce((n, g) => n + g.items.length, 0)}</sup></button>`)
    .join('');

  const renderGroups = () => {
    const cat = categories.find(c => c.id === state.cat)!;
    const total = cat.groups.reduce((n, g) => n + g.items.length, 0);
    groupsEl.innerHTML =
      `<button type="button" aria-pressed="${!state.group}" data-group="">Все серии<span>${total}</span></button>` +
      cat.groups.map(g => `<button type="button" aria-pressed="${state.group === g.id}" data-group="${g.id}">${esc(g.title)}<span>${g.items.length}</span></button>`).join('');
    groupsEl.hidden = !!state.q;
  };

  const render = (animate: boolean) => {
    list = visible();
    const showGroup = !!state.q || !state.group;
    const slice = list.slice(0, state.limit);
    grid.innerHTML = slice.length
      ? slice.map((e, i) => card(e, i, showGroup)).join('')
      : `<li class="items__empty">Ничего не нашлось. Проверьте марку или <a href="#request">оставьте запрос</a> — подберём по чертежу.</li>`;
    more.hidden = list.length <= state.limit;
    more.querySelector('span')!.textContent = `Показать ещё ${Math.min(PAGE, list.length - state.limit)}`;
    shown.textContent = String(list.length);
    if (animate && !reducedMotion) {
      grid.classList.remove('is-in');
      requestAnimationFrame(() => requestAnimationFrame(() => grid.classList.add('is-in')));
    } else grid.classList.add('is-in');
  };

  tabs.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-cat]');
    if (!b || b.dataset.cat === state.cat) return;
    state.cat = b.dataset.cat!;
    state.group = '';
    state.limit = PAGE;
    $$('[data-cat]', tabs).forEach(x => x.setAttribute('aria-selected', String(x === b)));
    renderGroups();
    render(true);
  });
  // arrow keys move between tabs (ARIA tabs pattern)
  tabs.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const bs = $$<HTMLButtonElement>('[data-cat]', tabs);
    const i = bs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = bs[(i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length];
    next.focus();
    next.click();
  });
  groupsEl.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-group]');
    if (!b) return;
    state.group = b.dataset.group!;
    state.limit = PAGE;
    $$('[data-group]', groupsEl).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    render(true);
    if (isNarrow()) scrollToEl(grid);
  });
  more.addEventListener('click', () => {
    const from = state.limit;
    state.limit += PAGE;
    render(false);
    grid.querySelectorAll<HTMLElement>('.it')[from]?.focus({ preventScroll: true });
  });
  let st = 0;
  search.addEventListener('input', () => {
    clearTimeout(st);
    st = window.setTimeout(() => {
      state.q = normMark(search.value.trim());
      state.limit = PAGE;
      tabs.classList.toggle('is-muted', !!state.q);
      renderGroups();
      render(true);
    }, 160);
  });
  grid.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLElement>('[data-item]');
    if (b) openItem(b.dataset.item!, b.querySelector('img'));
  });

  renderGroups();
  render(false);
  initItemSheet();
}

/* ───────────── product sheet ───────────── */

const el = () => $('[data-isheet]')!;
let current: Entry | null = null;
let order: Entry[] = [];
let returnFocus: HTMLElement | null = null;
let tl: gsap.core.Timeline | null = null;

function tableHtml(rows: Cell[][]) {
  const [head, ...body] = rows;
  const cell = (c: Cell, tag: string) => `<${tag}${c.rs ? ` rowspan="${c.rs}"` : ''}${c.cs ? ` colspan="${c.cs}"` : ''}>${esc(c.t)}</${tag}>`;
  return `<div class="ptable"><table><thead><tr>${head.map(c => cell(c, 'th')).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => cell(c, 'td')).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/**
 * The same table as one block per row, "column: value" — for phones, where a table of 5–8
 * columns cannot be read. Row spans are followed so every value gets its own column's name;
 * a spanned value (e.g. the total mass of a bill of materials) is shown once, in its first row.
 * Tables with a two-row header are left as tables (their columns cannot be named reliably).
 */
function stackHtml(rows: Cell[][]): string | null {
  const [head, ...body] = rows;
  if (head.some(c => (c.cs ?? 1) > 1 || (c.rs ?? 1) > 1)) return null;
  const labels = head.map(c => c.t);
  const n = labels.length;
  const busy = new Array<number>(n).fill(0);
  const blocks: string[] = [];
  for (const row of body) {
    let col = 0;
    const pairs: [string, string][] = [];
    for (const c of row) {
      while (col < n && busy[col] > 0) busy[col++]--;
      pairs.push([labels[col] ?? '', c.t]);
      if ((c.rs ?? 1) > 1 && col < n) busy[col] = (c.rs ?? 1) - 1;
      col += c.cs ?? 1;
    }
    for (; col < n; col++) if (busy[col] > 0) busy[col]--;
    if (!pairs.length) continue;
    const [first, ...rest] = pairs;
    blocks.push(
      `<div class="pstack__row"><p class="pstack__t"><span>${esc(first[0])}</span>${esc(first[1])}</p><dl>${rest
        .map(([l, v]) => `<div><dt>${esc(l)}</dt><dd>${esc(v)}</dd></div>`)
        .join('')}</dl></div>`,
    );
  }
  return `<div class="pstack">${blocks.join('')}</div>`;
}

/** "Накладка ОГ6 (3.407.1-143.8.29) — левая половина…" → "Накладка ОГ6": the sheet's own name */
const sheetName = (title: string) => title.split(/\s[—(]|\s-\s/)[0].trim().slice(0, 80);

function fill(e: Entry) {
  const it = e.item;
  const s = el();
  $('[data-isheet-kind]', s)!.textContent = `${e.cat.title} · ${e.group.title}`;
  $('[data-isheet-mark]', s)!.textContent = it.mark;
  $('[data-isheet-name]', s)!.textContent = it.name === it.mark ? '' : it.name;
  $('[data-isheet-bg]', s)!.textContent = it.mark;
  const keys: [string, string][] = [];
  if (it.keys.H != null) keys.push([num(it.keys.H), 'Высота, м']);
  if (it.keys.mass != null) keys.push([num(it.keys.mass), 'Масса, кг']);
  const k = $('[data-isheet-keys]', s)!;
  k.innerHTML = keys.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  k.hidden = !keys.length;
  k.style.gridTemplateColumns = `repeat(${Math.max(keys.length, 1)}, 1fr)`;
  const note = $('[data-isheet-note]', s)!;
  note.textContent = it.note;
  note.hidden = !it.note;
  // each table twice: as a table (wide screens) and stacked by row (phones); CSS shows one
  $('[data-isheet-tables]', s)!.innerHTML = it.tables
    .map(t => {
      const stack = stackHtml(t);
      return stack ? `<div class="ptables has-stack">${tableHtml(t)}${stack}</div>` : tableHtml(t);
    })
    .join('');
  const img = $<HTMLImageElement>('[data-isheet-img]', s)!;
  const none = $('[data-isheet-none]', s)!;
  if (it.draw) {
    img.hidden = false;
    img.src = drawSrc(it);
    img.alt = `Схема: ${it.name}`;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
  }
  none.hidden = !!it.draw;
  none.innerHTML = it.draw ? '' : passportHtml(it, 6, 'pass pass--big', e.group.title);
  const cap = $('[data-isheet-cap]', s)!;
  // one scheme is shown for the whole series: say so, so its figures are not read as this mark's
  cap.textContent = !it.draw
    ? ''
    : it.base
      ? `Лист опоры ${it.base}: эта марка — та же опора на подставке`
    : it.drawKind === 'sheet' && it.sheet
      ? `Лист типовой серии ${it.sheet.series}${sheetName(it.sheet.title) ? ` — ${sheetName(it.sheet.title)}` : ''}`
      : it.drawKind === 'picture'
      ? 'Изображение изделия, перерисованное с его фотографии или 3D-модели; это не чертёж'
      : it.series
        ? 'Схема серии: на ней одна из марок. Размеры этой марки — в таблице или по запросу'
        : '';
  $('[data-isheet-pos]', s)!.textContent = `${order.indexOf(e) + 1} / ${order.length}`;
}

/** The drawing is "plotted": revealed top to bottom, like a pen plotter drawing the sheet. */
function plot(t: gsap.core.Timeline, at: gsap.Position) {
  t.fromTo('[data-isheet-plot]', { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 0.9, ease: 'power2.inOut' }, at);
}

export function openItem(slug: string, from: HTMLImageElement | null = null, push = true) {
  const e = itemBySlug.get(slug);
  if (!e) return;
  const s = el();
  order = list.includes(e) ? list : all.filter(x => x.group === e.group);
  if (!s.hidden) return swap(e);
  current = e;
  returnFocus = (document.activeElement as HTMLElement) ?? null;
  if (push) history.pushState({ item: slug }, '', `#/izdelie/${slug}`);
  s.hidden = false;
  lockScroll(true);
  fill(e);
  $<HTMLButtonElement>('[data-isheet-close]', s)!.focus({ preventScroll: true });
  if (reducedMotion) return;
  tl?.progress(1).kill();
  const frame = $<SVGRectElement>('[data-isheet-frame] rect', s)!;
  const per = 2 * (s.clientWidth + s.clientHeight);
  tl = gsap.timeline({ onComplete: () => void (tl = null) });
  tl.fromTo(s, { backgroundColor: 'rgba(238,240,238,0)' }, { backgroundColor: 'rgba(238,240,238,1)', duration: 0.3, ease: 'power2.out' }, 0)
    .fromTo(frame, { strokeDasharray: per, strokeDashoffset: per }, { strokeDashoffset: 0, duration: 0.8, ease: 'power2.inOut' }, 0.05)
    .from('[data-isheet-bg]', { xPercent: 10, opacity: 0, duration: 0.8, ease: 'expo.out' }, 0.25)
    .from('[data-isheet] .sheet__info > *', { y: 14, opacity: 0, duration: 0.55, ease: 'power3.out', stagger: 0.05 }, 0.25)
    .from('[data-isheet] .sheet__nav, [data-isheet-close]', { opacity: 0, duration: 0.4 }, 0.4);
  plot(tl, from ? 0.15 : 0.2);
}

function swap(e: Entry, dir = 0) {
  if (e === current) return;
  current = e;
  // reached by a link from another series: step through that item's own series
  if (!order.includes(e)) order = list.includes(e) ? list : all.filter(x => x.group === e.group);
  history.replaceState({ item: e.item.slug }, '', `#/izdelie/${e.item.slug}`);
  tl?.progress(1).kill();
  if (reducedMotion || !dir) return fill(e);
  tl = gsap.timeline({ onComplete: () => void (tl = null) });
  tl.to('[data-isheet-plot], [data-isheet] .sheet__info', { opacity: 0, x: -dir * 40, duration: 0.2, ease: 'power2.in' })
    .add(() => fill(e))
    .set('[data-isheet-plot]', { opacity: 1, x: 0 })
    .fromTo('[data-isheet] .sheet__info', { opacity: 0, x: dir * 40 }, { opacity: 1, x: 0, duration: 0.45, ease: 'expo.out' });
  plot(tl, '<');
}

function step(dir: number) {
  if (!current || !order.length) return;
  const i = order.indexOf(current);
  swap(order[(i + dir + order.length) % order.length], dir);
}

function closeItem(fromHistory = false) {
  const s = el();
  if (s.hidden) return;
  tl?.progress(1).kill();
  if (!fromHistory) history.back();
  const done = () => {
    s.hidden = true;
    gsap.set([s, '[data-isheet] .sheet__info', '[data-isheet-plot]'], { clearProps: 'opacity,backgroundColor,transform,clipPath' });
    lockScroll(false);
    current = null;
    returnFocus?.focus({ preventScroll: true });
  };
  if (reducedMotion) return done();
  tl = gsap.timeline({ onComplete: () => void ((tl = null), done()) });
  tl.to(s, { opacity: 0, duration: 0.3, ease: 'power2.out' });
}

function initItemSheet() {
  const s = el();
  $('[data-isheet-close]', s)!.addEventListener('click', () => closeItem());
  $('[data-isheet-prev]', s)!.addEventListener('click', () => step(-1));
  $('[data-isheet-next]', s)!.addEventListener('click', () => step(1));
  $('[data-isheet-request]', s)!.addEventListener('click', ev => {
    ev.preventDefault();
    if (!current) return;
    prefillRequest([current.item.mark], 'Изделия');
    closeItem();
    setTimeout(() => scrollToEl('#request'), reducedMotion ? 0 : 450);
  });
  s.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeItem();
    else if (e.key === 'ArrowLeft' && !(e.target as Element).closest('.ptable')) step(-1);
    else if (e.key === 'ArrowRight' && !(e.target as Element).closest('.ptable')) step(1);
    else if (e.key === 'Tab') {
      const f = $$<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])', s).filter(n => n.offsetParent !== null);
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  let sx = 0, sy = 0;
  const draw = $('[data-isheet-draw]', s)!;
  draw.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
  draw.addEventListener('pointerup', e => {
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && isNarrow()) closeItem();
  });
  window.addEventListener('popstate', () => {
    const m = location.hash.match(/^#\/izdelie\/([\w-]+)/);
    if (m && itemBySlug.has(m[1])) {
      if (s.hidden) openItem(m[1], null, false);
      else swap(itemBySlug.get(m[1])!);
    } else if (!s.hidden) closeItem(true);
  });
}

/** A shared link to a product opens its sheet on boot. */
export function openItemFromLocation(hash: string) {
  const m = hash.match(/^#\/izdelie\/([\w-]+)/);
  if (m && itemBySlug.has(m[1])) {
    history.replaceState(null, '', location.pathname + location.search);
    openItem(m[1], null, true);
  }
}
