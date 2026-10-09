import { gsap, Flip } from '../core/smooth';
import { $, $$, finePointer, reducedMotion, fmt, isNarrow } from '../core/env';
import { towers, maxH, normMark, type Tower } from './data';
import { openSheet, onSheetChange } from './sheet';
import { initCompare, toggleCompare, compareSet } from './compare';

interface State { kv: number; q: string; view: 'line' | 'table' }
const state: State = { kv: 0, q: '', view: 'line' };

let pxPerM = 10;
const nodes = new Map<string, HTMLLIElement>();

export function visibleTowers(): Tower[] {
  return towers.filter(t => matches(t));
}
function matches(t: Tower) {
  return (!state.kv || t.kv === state.kv) && (!state.q || normMark(t.mark).includes(state.q));
}

export function lineupNode(slug: string) {
  return nodes.get(slug) ?? null;
}

export function initCatalog() {
  const root = $('[data-catalog]');
  if (!root) return;
  const lineup = $('[data-lineup]', root)!;
  const viewport = $('[data-lineup-viewport]', root)!;
  const track = $('[data-lineup-track]', root)!;
  const scaleEl = $('[data-scale]', root)!;
  const wiresSvg = $<SVGSVGElement>('[data-lineup-wires]', root)!;
  const minimap = $('[data-minimap]', root)!;
  const win = $('[data-minimap-win]', root)!;
  const table = $('[data-ctable]', root)!;
  const shown = $('[data-count-shown]', root)!;

  // ── build the lineup ────────────────────────────────────
  const measure = () => {
    const lh = scaleEl.getBoundingClientRect().height || 480;
    pxPerM = (lh * 0.9) / maxH;
    lineup.style.setProperty('--ppm', String(pxPerM));
    return lh;
  };
  let lh = measure();


  let lastKv = 0;
  for (const t of towers) {
    const li = document.createElement('li');
    li.className = 'tw';
    li.dataset.slug = t.slug;
    if (t.kv !== lastKv) {
      li.classList.add('is-group-start');
      li.dataset.group = `${t.kv} кВ`;
      lastKv = t.kv;
    }
    li.innerHTML = `
      <span class="tw__group" aria-hidden="true">${t.kv} кВ</span>
      <button class="tw__btn" type="button" aria-label="${t.mark}, ${t.kv} кВ, высота ${fmt(t.H)} м — открыть чертёж">
        <span class="tw__tip" aria-hidden="true"></span>
        <img class="tw__sil" alt="" loading="lazy" decoding="async" src="${t.svgTower}">
      </button>
      <p class="tw__label"><b>${t.mark}</b><span>${fmt(t.H)} м</span></p>`;
    nodes.set(t.slug, li);
    track.appendChild(li);
  }

  const sizeTowers = () => {
    for (const t of towers) {
      const li = nodes.get(t.slug)!;
      // the tower crop spans the tower's height H (plus a 1-unit margin)
      const [x0, y0, x1, y1] = t.draw.tower;
      const k = (t.H * pxPerM) / (y1 - y0);
      const h = (y1 - y0 + 2) * k;
      const w = (x1 - x0 + 2) * k;
      li.style.setProperty('--h', `${h}px`);
      const img = li.querySelector('img')!;
      img.style.height = `${h}px`;
      img.style.width = `${w}px`;
    }
    // height scale (every 10 m)
    scaleEl.innerHTML = '';
    for (let m = 10; m <= maxH; m += 10) {
      const d = document.createElement('div');
      d.style.top = `${lh - m * pxPerM}px`;
      d.innerHTML = `<span>${m} м</span>`;
      scaleEl.appendChild(d);
    }
  };
  sizeTowers();

  // ── conductors between neighbouring towers ──────────────
  const drawWires = () => {
    const vis = towers.filter(matches).map(t => nodes.get(t.slug)!);
    const base = track.getBoundingClientRect();
    let d = '';
    for (let i = 0; i < vis.length - 1; i++) {
      const a = vis[i].querySelector('.tw__btn')!.getBoundingClientRect();
      const b = vis[i + 1].querySelector('.tw__btn')!.getBoundingClientRect();
      for (const f of [0.72, 0.58]) {
        const x1 = a.right - base.left - a.width * 0.12;
        const x2 = b.left - base.left + b.width * 0.12;
        const y1 = lh - a.height * f;
        const y2 = lh - b.height * f;
        const sag = Math.min(40, (x2 - x1) * 0.12);
        d += `M${x1.toFixed(1)} ${y1.toFixed(1)}Q${((x1 + x2) / 2).toFixed(1)} ${(Math.max(y1, y2) + sag).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      }
    }
    wiresSvg.setAttribute('width', String(track.scrollWidth));
    wiresSvg.setAttribute('height', String(lh));
    wiresSvg.innerHTML = `<path d="${d}"/>`;
  };

  // ── minimap: a skyline of bars, the window shows what is on screen ──
  const drawMinimap = () => {
    minimap.querySelectorAll('i').forEach(n => n.remove());
    const vis = towers.filter(matches);
    const total = track.scrollWidth;
    const base = track.getBoundingClientRect().left;
    const mw = minimap.clientWidth;
    for (const t of vis) {
      const r = nodes.get(t.slug)!.querySelector('.tw__btn')!.getBoundingClientRect();
      const bar = document.createElement('i');
      bar.style.cssText = `position:absolute;bottom:0;width:2px;background:var(--graphite);left:${((r.left - base + r.width / 2) / total) * mw}px;height:${(t.H / maxH) * 100}%`;
      minimap.appendChild(bar);
    }
    syncWindow();
  };
  const syncWindow = () => {
    const total = track.scrollWidth;
    const mw = minimap.clientWidth;
    win.style.left = `${(viewport.scrollLeft / total) * mw}px`;
    win.style.width = `${Math.min(1, viewport.clientWidth / total) * mw}px`;
  };
  viewport.addEventListener('scroll', syncWindow, { passive: true });
  const jumpTo = (clientX: number) => {
    const r = minimap.getBoundingClientRect();
    const f = (clientX - r.left) / r.width;
    viewport.scrollLeft = f * track.scrollWidth - viewport.clientWidth / 2;
  };
  minimap.addEventListener('pointerdown', e => {
    jumpTo(e.clientX);
    minimap.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => jumpTo(ev.clientX);
    minimap.addEventListener('pointermove', move);
    minimap.addEventListener('pointerup', () => minimap.removeEventListener('pointermove', move), { once: true });
  });

  // ── horizontal gestures stay inside the strip; vertical wheel scrolls the page ──
  viewport.addEventListener('wheel', e => { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.stopPropagation(); }, { passive: true });
  viewport.setAttribute('data-lenis-prevent-touch', '');

  // drag to scroll with momentum (mouse); touch uses native scrolling
  let dragging = false;
  let moved = 0;
  if (finePointer) {
    let sx = 0, sl = 0, vx = 0, lx = 0, lt = 0;
    viewport.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return;
      dragging = true;
      moved = 0;
      sx = lx = e.clientX;
      sl = viewport.scrollLeft;
      lt = performance.now();
      gsap.killTweensOf(viewport);
    });
    window.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      moved = Math.max(moved, Math.abs(dx));
      if (moved > 4) viewport.classList.add('is-drag');
      viewport.scrollLeft = sl - dx;
      const now = performance.now();
      vx = (e.clientX - lx) / Math.max(1, now - lt);
      lx = e.clientX;
      lt = now;
    });
    window.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      viewport.classList.remove('is-drag');
      if (moved > 4 && !reducedMotion) gsap.to(viewport, { scrollLeft: viewport.scrollLeft - vx * 380, duration: 0.9, ease: 'power3.out' });
    });
  }

  // ── hover: the tower under the pointer is "energised" ───
  track.addEventListener('pointerover', e => {
    const li = (e.target as Element).closest('.tw');
    nodes.forEach(n => n.classList.toggle('is-hover', n === li));
    lineup.classList.toggle('is-hovering', !!li);
  });
  track.addEventListener('pointerleave', () => {
    nodes.forEach(n => n.classList.remove('is-hover'));
    lineup.classList.remove('is-hovering');
  });

  // ── open ────────────────────────────────────────────────
  track.addEventListener('click', e => {
    const btn = (e.target as Element).closest('.tw__btn');
    if (!btn || moved > 4) return;
    const slug = btn.closest<HTMLElement>('.tw')!.dataset.slug!;
    openSheet(slug, btn.querySelector('img')!);
  });
  table.addEventListener('click', e => {
    const tr = (e.target as Element).closest<HTMLElement>('tr[data-slug]');
    if (!tr) return;
    e.preventDefault();
    openSheet(tr.dataset.slug!, null);
  });

  // ── filters ─────────────────────────────────────────────
  const apply = (animate = true) => {
    const state0 = animate && !reducedMotion && state.view === 'line' ? Flip.getState($$('.tw', track)) : null;
    let n = 0;
    for (const t of towers) {
      const ok = matches(t);
      nodes.get(t.slug)!.classList.toggle('is-out', !ok);
      if (ok) n++;
    }
    $$<HTMLTableRowElement>('tr[data-slug]', table).forEach(tr => {
      const t = towers.find(x => x.slug === tr.dataset.slug)!;
      tr.classList.toggle('is-out', !matches(t));
    });
    // group label sits on the first visible tower of each voltage class
    let prev = 0;
    for (const t of towers) {
      const li = nodes.get(t.slug)!;
      const first = matches(t) && t.kv !== prev;
      li.classList.toggle('is-group-start', first);
      if (first) {
        li.dataset.group = `${t.kv} кВ`;
        prev = t.kv;
      }
    }
    shown.textContent = String(n);
    const done = () => {
      drawWires();
      drawMinimap();
    };
    if (state0) {
      Flip.from(state0, {
        duration: 0.7,
        ease: 'power3.inOut',
        stagger: 0.008,
        onEnter: els => gsap.fromTo(els, { yPercent: 100, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.7, ease: 'power3.out', stagger: 0.015 }),
        onLeave: els => gsap.to(els, { yPercent: 100, opacity: 0, duration: 0.35, ease: 'power2.in' }),
        onComplete: done,
      });
      gsap.to(wiresSvg, { opacity: 0, duration: 0.15, onComplete: () => void gsap.to(wiresSvg, { opacity: 0.45, duration: 0.4, delay: 0.7 }) });
    } else done();
    viewport.scrollTo({ left: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  };

  $$<HTMLButtonElement>('[data-kv-btn]', root).forEach(b =>
    b.addEventListener('click', () => {
      state.kv = Number(b.dataset.kvBtn);
      $$('[data-kv-btn]', root).forEach(x => x.setAttribute('aria-selected', String(x === b)));
      apply();
    }),
  );

  const search = $<HTMLInputElement>('[data-search]', root)!;
  let st = 0;
  search.addEventListener('input', () => {
    clearTimeout(st);
    st = window.setTimeout(() => {
      state.q = normMark(search.value.trim());
      apply();
      // an exact mark scrolls into view and lights up
      const exact = towers.find(t => matches(t) && normMark(t.mark) === state.q);
      if (exact) setTimeout(() => focusTower(exact.slug), 750);
    }, 160);
  });
  search.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const first = towers.find(matches);
    if (first) openSheet(first.slug, nodes.get(first.slug)!.querySelector('img'));
  });

  const focusTower = (slug: string) => {
    const li = nodes.get(slug);
    if (!li) return;
    const left = li.offsetLeft - viewport.clientWidth / 2 + li.offsetWidth / 2;
    viewport.scrollTo({ left, behavior: reducedMotion ? 'auto' : 'smooth' });
    nodes.forEach(n => n.classList.toggle('is-hover', n === li));
    lineup.classList.add('is-hovering');
    setTimeout(() => {
      li.classList.remove('is-hover');
      lineup.classList.remove('is-hovering');
    }, 1600);
  };

  $$<HTMLButtonElement>('[data-view]', root).forEach(b =>
    b.addEventListener('click', () => {
      state.view = b.dataset.view as State['view'];
      $$('[data-view]', root).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      lineup.hidden = state.view !== 'line';
      table.hidden = state.view !== 'table';
      if (state.view === 'line') requestAnimationFrame(() => { drawWires(); drawMinimap(); });
    }),
  );

  // towers rise out of the ground the first time the lineup is seen
  if (!reducedMotion) {
    const first = $$('.tw', track).slice(0, isNarrow() ? 6 : 14);
    gsap.set(first, { yPercent: 100 });
    gsap.to(first, { yPercent: 0, duration: 1.1, ease: 'expo.out', stagger: 0.05, scrollTrigger: { trigger: lineup, start: 'top 80%', once: true } });
  }

  // image sizes are set up front, so wires can be drawn before the drawings load
  requestAnimationFrame(() => {
    drawWires();
    drawMinimap();
  });
  let rt = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => {
      lh = measure();
      sizeTowers();
      drawWires();
      drawMinimap();
    });
  }).observe(scaleEl);

  initCompare();
  onSheetChange(slug => {
    // keep the compare markers in the lineup in sync
    nodes.forEach((li, s) => {
      li.querySelector('.tw__check')?.remove();
      if (compareSet.has(s)) li.insertAdjacentHTML('afterbegin', '<span class="tw__check">в сравнении</span>');
    });
    if (slug) focusTower(slug);
  });
  void toggleCompare;
}
