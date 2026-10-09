import { gsap, lockScroll, scrollToEl } from '../core/smooth';
import { $, $$, fmt, isNarrow, reducedMotion } from '../core/env';
import { bySlug, esc, kvLabel, type Tower } from './data';
import { lineupNode, visibleTowers } from './catalog';
import { compareSet, toggleCompare } from './compare';
import { prefillRequest } from '../ui/form';

const sheet = () => $('[data-sheet]')!;
let current: Tower | null = null;
let list: Tower[] = [];
let returnFocus: HTMLElement | null = null;
let busy = false;
let closing = false;
/** the running open/swap timeline; finished early when the user acts again */
let active: gsap.core.Timeline | null = null;
const settle = () => {
  const a = active;
  active = null;
  // progress(1) fires onComplete, which also clears `active`
  a?.progress(1).kill();
  busy = false;
};
const listeners: ((slug: string | null) => void)[] = [];
export const onSheetChange = (cb: (slug: string | null) => void) => listeners.push(cb);
const emit = (s: string | null) => listeners.forEach(cb => cb(s));

/** Fits the 1:1 drawing (with all its dimensions) into the left panel. */
function layoutFigure(t: Tower) {
  const draw = $('[data-sheet-draw]')!;
  const fig = $('[data-sheet-fig]')!;
  const r = draw.getBoundingClientRect();
  const d = t.draw;
  const s = Math.min((r.height * 0.9) / d.h, (r.width * 0.9) / d.w);
  fig.style.width = `${d.w * s}px`;
  fig.style.height = `${d.h * s}px`;
  const [x0, y0, x1, y1] = d.tower;
  const fr = fig.getBoundingClientRect();
  return { s, towerRect: { x: fr.left + x0 * s, y: fr.top + y0 * s, w: (x1 - x0) * s, h: (y1 - y0) * s } };
}

function fill(t: Tower) {
  const pos = list.findIndex(x => x.slug === t.slug);
  $('[data-sheet-kv]')!.textContent = kvLabel(t.kv);
  $('[data-sheet-mark]')!.textContent = t.mark;
  $('[data-sheet-bg]')!.textContent = t.mark;
  const img = $<HTMLImageElement>('[data-sheet-img]')!;
  img.src = t.svg;
  img.alt = `Чертёж опоры ${t.mark} с размерами`;
  img.width = t.draw.w;
  img.height = t.draw.h;
  const keys: [string, string][] = [
    [fmt(t.H), 'Высота опоры H, м'],
    [t.mass == null ? '—' : t.mass.toLocaleString('ru-RU'), 'Масса с цинком, кг'],
    [fmt(t.L, 2), 'Размер в осях фундамента L, м'],
  ];
  $('[data-sheet-keys]')!.innerHTML = keys.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
  const tb = $('[data-sheet-specs]')!;
  tb.innerHTML = t.specs.map((s, i) => `<tr style="--i:${i}"><th scope="row">${esc(s.label)}</th><td>${esc(s.value)}</td></tr>`).join('');
  tb.parentElement!.classList.remove('is-in');
  requestAnimationFrame(() => requestAnimationFrame(() => tb.parentElement!.classList.add('is-in')));
  $('[data-sheet-pos]')!.textContent = `${pos + 1} / ${list.length}`;
  const cmp = $('[data-sheet-compare]')!;
  cmp.setAttribute('aria-pressed', String(compareSet.has(t.slug)));
  $('span', cmp)!.textContent = compareSet.has(t.slug) ? 'В сравнении' : 'Добавить к сравнению';
}

export function openSheet(slug: string, from: HTMLImageElement | null, push = true) {
  const t = bySlug.get(slug);
  if (!t || busy) return;
  const el = sheet();
  const wasOpen = !el.hidden;
  list = visibleTowers();
  if (!list.some(x => x.slug === slug)) list = [...bySlug.values()];
  if (wasOpen) return swap(t, 0);
  current = t;
  returnFocus = (document.activeElement as HTMLElement) ?? null;
  if (push) history.pushState({ sheet: slug }, '', `#/opora/${slug}`);
  el.hidden = false;
  lockScroll(true);
  fill(t);
  const { towerRect } = layoutFigure(t);
  $<HTMLButtonElement>('[data-sheet-close]')!.focus({ preventScroll: true });
  emit(null);

  if (reducedMotion) return;
  busy = true;
  const tl = gsap.timeline({ onComplete: () => void ((busy = false), (active = null)) });
  active = tl;
  const frame = $<SVGRectElement>('[data-sheet-frame] rect')!;
  const per = 2 * (el.clientWidth + el.clientHeight);
  tl.fromTo(el, { backgroundColor: 'rgba(238,240,238,0)' }, { backgroundColor: 'rgba(238,240,238,1)', duration: 0.35, ease: 'power2.out' }, 0)
    .fromTo(frame, { strokeDasharray: per, strokeDashoffset: per }, { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut' }, 0.05)
    .from('.sheet__draw', { opacity: 0, duration: 0.4 }, 0.1)
    .from('[data-sheet-bg]', { xPercent: 12, opacity: 0, duration: 0.9, ease: 'expo.out' }, 0.3)
    .from(['[data-sheet-kv]', '[data-sheet-mark]'], { yPercent: 60, opacity: 0, duration: 0.7, ease: 'expo.out', stagger: 0.06 }, 0.32)
    .from('[data-sheet-keys] > div', { y: 16, opacity: 0, duration: 0.6, ease: 'power3.out', stagger: 0.06 }, 0.42)
    .from('.sheet__actions, .sheet__nav, .sheet__close', { opacity: 0, duration: 0.5 }, 0.55);
  countKeys(tl, 0.45);

  const img = $<HTMLImageElement>('[data-sheet-img]')!;
  if (from && from.getBoundingClientRect().width > 0) {
    // the silhouette physically flies from the lineup into the drawing, then the original takes over
    const a = from.getBoundingClientRect();
    const ghost = from.cloneNode() as HTMLImageElement;
    ghost.className = 'sheet-ghost';
    ghost.style.width = `${a.width}px`;
    ghost.style.height = `${a.height}px`;
    document.body.appendChild(ghost);
    gsap.set(ghost, { x: a.left, y: a.top });
    from.style.opacity = '0';
    tl.to(ghost, { x: towerRect.x, y: towerRect.y, scaleX: towerRect.w / a.width, scaleY: towerRect.h / a.height, duration: 0.75, ease: 'expo.inOut' }, 0)
      .fromTo(img, { opacity: 0 }, { opacity: 1, duration: 0.35 }, 0.62)
      .to(ghost, { opacity: 0, duration: 0.3, onComplete: () => { ghost.remove(); from.style.opacity = ''; } }, 0.72);
  } else {
    tl.from(img, { opacity: 0, y: 30, duration: 0.8, ease: 'expo.out' }, 0.2);
  }
}

function countKeys(tl: gsap.core.Timeline, at: number) {
  $$('[data-sheet-keys] b').forEach(b => {
    const raw = b.textContent ?? '';
    const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
    if (!isFinite(n) || raw === '—') return;
    const digits = raw.includes(',') ? raw.split(',')[1].length : 0;
    const o = { v: 0 };
    tl.to(o, { v: n, duration: 0.9, ease: 'power2.out', onUpdate: () => (b.textContent = o.v.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })) }, at);
  });
}

/** Move to the neighbouring tower without closing the sheet. dir: -1 / 1 */
function swap(t: Tower, dir: number) {
  if (t === current) return;
  settle();
  current = t;
  history.replaceState({ sheet: t.slug }, '', `#/opora/${t.slug}`);
  if (reducedMotion || !dir) {
    fill(t);
    layoutFigure(t);
    return;
  }
  busy = true;
  active = gsap.timeline({ onComplete: () => void ((busy = false), (active = null)) });
  active
    .to('[data-sheet-fig]', { x: -dir * 120, opacity: 0, duration: 0.28, ease: 'power2.in' })
    .to('[data-sheet-bg]', { xPercent: -dir * 18, opacity: 0, duration: 0.28, ease: 'power2.in' }, 0)
    .to('.sheet__info', { opacity: 0, duration: 0.2 }, 0)
    .add(() => {
      fill(t);
      layoutFigure(t);
    })
    .fromTo('[data-sheet-fig]', { x: dir * 120, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, ease: 'expo.out' })
    .fromTo('[data-sheet-bg]', { xPercent: dir * 18, opacity: 0 }, { xPercent: 0, opacity: 1, duration: 0.7, ease: 'expo.out' }, '<')
    .to('.sheet__info', { opacity: 1, duration: 0.3 }, '<0.1');
}

export function step(dir: number) {
  if (!current) return;
  const i = list.findIndex(x => x.slug === current!.slug);
  const next = list[(i + dir + list.length) % list.length];
  swap(next, dir);
}

export function closeSheet(fromHistory = false) {
  const el = sheet();
  if (el.hidden || closing) return;
  settle();
  closing = true;
  const t = current!;
  if (!fromHistory) history.back();
  const done = () => {
    el.hidden = true;
    gsap.set([el, '.sheet__draw', '.sheet__info', '.sheet__nav', '.sheet__close', '[data-sheet-bg]', '[data-sheet-img]', '[data-sheet-frame]'], { clearProps: 'opacity,backgroundColor,transform' });
    gsap.set('[data-sheet-fig]', { x: 0, opacity: 1 });
    lockScroll(false);
    current = null;
    busy = false;
    closing = false;
    emit(t.slug);
    returnFocus?.focus({ preventScroll: true });
  };
  if (reducedMotion) return done();
  busy = true;
  // fly back into the lineup when the tower is there
  const li = lineupNode(t.slug);
  const target = li && !li.classList.contains('is-out') && !li.closest('[hidden]') ? li.querySelector('img') : null;
  if (target) {
    const vp = li!.closest<HTMLElement>('[data-lineup-viewport]')!;
    vp.scrollLeft = li!.offsetLeft - vp.clientWidth / 2 + li!.offsetWidth / 2;
  }
  const b = target?.getBoundingClientRect();
  const onScreen = b && b.top > -b.height && b.bottom < window.innerHeight + b.height;
  const tl = gsap.timeline({ onComplete: done });
  tl.to(['.sheet__info', '.sheet__nav', '.sheet__close', '[data-sheet-bg]'], { opacity: 0, duration: 0.25 }, 0);
  if (target && onScreen) {
    const { towerRect } = layoutFigure(t);
    const ghost = target.cloneNode() as HTMLImageElement;
    ghost.className = 'sheet-ghost';
    ghost.style.width = `${b!.width}px`;
    ghost.style.height = `${b!.height}px`;
    document.body.appendChild(ghost);
    target.style.opacity = '0';
    gsap.set(ghost, { x: towerRect.x, y: towerRect.y, scaleX: towerRect.w / b!.width, scaleY: towerRect.h / b!.height });
    tl.to('[data-sheet-img]', { opacity: 0, duration: 0.2 }, 0)
      .to(ghost, { x: b!.left, y: b!.top, scaleX: 1, scaleY: 1, duration: 0.7, ease: 'expo.inOut', onComplete: () => { ghost.remove(); target.style.opacity = ''; } }, 0.05)
      .to(el, { backgroundColor: 'rgba(238,240,238,0)', duration: 0.45 }, 0.2)
      .to('.sheet__draw, [data-sheet-frame]', { opacity: 0, duration: 0.3 }, 0.1);
  } else {
    tl.to(el, { opacity: 0, duration: 0.35 }, 0.1);
  }
}

export function initSheet() {
  const el = sheet();
  $('[data-sheet-close]')!.addEventListener('click', () => closeSheet());
  $('[data-sheet-prev]')!.addEventListener('click', () => step(-1));
  $('[data-sheet-next]')!.addEventListener('click', () => step(1));
  $('[data-sheet-compare]')!.addEventListener('click', () => {
    if (!current) return;
    toggleCompare(current.slug);
    fill(current);
    emit(null);
  });
  $('[data-sheet-request]')!.addEventListener('click', e => {
    e.preventDefault();
    if (!current) return;
    prefillRequest([current.mark]);
    closeSheet();
    setTimeout(() => scrollToEl('#request'), reducedMotion ? 0 : 900);
  });

  el.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSheet();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Tab') {
      // keep focus inside the dialog
      const f = $$<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])', el).filter(n => n.offsetParent !== null);
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // swipe between towers on touch; swipe down on the drawing closes
  let sx = 0, sy = 0;
  const draw = $('[data-sheet-draw]')!;
  draw.addEventListener('pointerdown', e => { sx = e.clientX; sy = e.clientY; });
  draw.addEventListener('pointerup', e => {
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && isNarrow()) closeSheet();
  });

  window.addEventListener('resize', () => current && !el.hidden && layoutFigure(current));

  // deep links and the back button
  const fromHash = () => {
    const m = location.hash.match(/^#\/opora\/([\w-]+)/);
    if (m && bySlug.has(m[1])) {
      if (el.hidden) openSheet(m[1], null, false);
      else if (current?.slug !== m[1]) swap(bySlug.get(m[1])!, 0);
    } else if (!el.hidden) closeSheet(true);
  };
  window.addEventListener('popstate', fromHash);
  gsap.set('[data-sheet-fig]', { xPercent: -50, yPercent: -50 });
}

/** Called once on boot, so a shared link opens straight on the tower. */
export function openFromLocation(hash: string) {
  const m = hash.match(/^#\/opora\/([\w-]+)/);
  if (m && bySlug.has(m[1])) {
    history.replaceState(null, '', location.pathname + location.search);
    openSheet(m[1], null, true);
  }
}
