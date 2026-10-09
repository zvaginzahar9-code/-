import { gsap, ScrollTrigger } from '../core/smooth';
import { $, $$, isNarrow, reducedMotion, idle, clamp } from '../core/env';
import { buildTower, elevationPath, DEFAULT_TOWER, halfWidth } from '../tower/model';

export interface HeroLayout {
  w: number;
  h: number;
  /** px per metre */
  scale: number;
  /** tower axis x, ground y (px, stage coordinates) */
  axisX: number;
  groundY: number;
}

export const PHASES = ['КМД', 'Сборка', 'Цинкование', 'Линия'];
/** progress boundaries of the four phases */
export const PHASE_AT = [0, 0.2, 0.55, 0.78, 1];

export function heroLayout(stage: HTMLElement): HeroLayout {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const narrow = isNarrow();
  const towerPx = narrow ? h * 0.5 : h * 0.74;
  const scale = towerPx / DEFAULT_TOWER.height;
  return {
    w,
    h,
    scale,
    axisX: narrow ? w * 0.5 : w * 0.66,
    groundY: narrow ? h * 0.83 : h * 0.9,
  };
}

const SVGNS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const n = document.createElementNS(SVGNS, tag);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  parent?.appendChild(n);
  return n;
}

/** Elevation drawing with dimension lines; doubles as the no-WebGL fallback. */
function drawPoster(svg: SVGSVGElement, L: HeroLayout) {
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${L.w} ${L.h}`);
  const members = buildTower(DEFAULT_TOWER, isNarrow() ? 0.85 : 1);
  const g = el('g', { class: 'members' }, svg);
  // one path per height band so the intro can draw bottom → top
  const bands = 14;
  for (let b = 0; b < bands; b++) {
    const part = members.filter(m => m.order >= b / bands && m.order < (b + 1) / bands + (b === bands - 1 ? 1 : 0));
    el('path', { d: elevationPath(part, L.scale, L.axisX, L.groundY), 'data-band': b }, g);
  }
  // dimension lines (labels only, as on a typical drawing — the tower is a generic illustration)
  const dims = el('g', { class: 'dims' }, svg);
  const H = DEFAULT_TOWER.height * L.scale;
  const left = L.axisX - (halfWidth(DEFAULT_TOWER, 0) + 4.2) * L.scale;
  const dl = (d: string) => el('path', { d, class: 'dimline' }, dims);
  dl(`M${left} ${L.groundY}V${L.groundY - H}M${left - 6} ${L.groundY}h12M${left - 6} ${L.groundY - H}h12`);
  dl(`M${left + 6} ${L.groundY - H}H${L.axisX - 4}`);
  const t1 = el('text', { x: left - 12, y: L.groundY - H / 2, 'text-anchor': 'middle', transform: `rotate(-90 ${left - 12} ${L.groundY - H / 2})` }, dims);
  t1.textContent = 'H';
  const armY = L.groundY - DEFAULT_TOWER.arms[0].y * L.scale;
  const left2 = left + 22;
  dl(`M${left2} ${L.groundY}V${armY}M${left2 - 5} ${armY}h10M${left2 + 6} ${armY}H${L.axisX - halfWidth(DEFAULT_TOWER, DEFAULT_TOWER.arms[0].y) * L.scale - 4}`);
  const t2 = el('text', { x: left2 - 9, y: L.groundY - (L.groundY - armY) / 2, 'text-anchor': 'middle', transform: `rotate(-90 ${left2 - 9} ${L.groundY - (L.groundY - armY) / 2})` }, dims);
  t2.textContent = 'h';
  const bw = halfWidth(DEFAULT_TOWER, 0) * L.scale;
  const by = L.groundY + 22;
  dl(`M${L.axisX - bw} ${L.groundY + 4}V${by + 6}M${L.axisX + bw} ${L.groundY + 4}V${by + 6}M${L.axisX - bw} ${by}H${L.axisX + bw}`);
  const t3 = el('text', { x: L.axisX, y: by + 16, 'text-anchor': 'middle' }, dims);
  t3.textContent = 'L';
  // ground line
  el('path', { d: `M${L.axisX - 220} ${L.groundY}H${L.axisX + 220}`, class: 'dimline' }, dims);
  return { members: g, dims };
}

export function initHero() {
  const hero = $('[data-hero]');
  const stage = $('.hero__stage', hero!) as HTMLElement;
  const svg = $<SVGSVGElement>('[data-hero-poster]')!;
  const canvas = $<HTMLCanvasElement>('[data-hero-gl]')!;
  const phases = $$('.phase', hero!);
  const stageLabel = $('[data-stamp-stage]')!;
  const sheetLabel = $('[data-stamp-sheet]')!;
  const bar = $('[data-stamp-bar]')!;
  const copy = $('.hero__copy', hero!)!;
  if (!hero) return;

  let layout = heroLayout(stage);
  let poster = drawPoster(svg, layout);
  let progress = 0;
  let scene: { setProgress(p: number): void; resize(L: HeroLayout): void } | null = null;

  // page-load moment: the drawing draws itself, title lines rise
  const paths = $$<SVGPathElement>('path', poster.members);
  if (!reducedMotion) {
    paths.forEach(p => {
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${len}`;
    });
    gsap.to(paths, { strokeDashoffset: 0, duration: 1.1, ease: 'power2.inOut', stagger: 0.07, delay: 0.15 });
    gsap.from(poster.dims, { opacity: 0, duration: 0.8, delay: 1.1 });
    gsap.from($$('.hero__title .line > span'), { yPercent: 110, duration: 1.1, ease: 'expo.out', stagger: 0.08, delay: 0.1 });
    gsap.from(['.hero__owner', '.hero__range', '.hero__lead', '.hero__phases', '.stamp'], { opacity: 0, y: 12, duration: 0.8, ease: 'power3.out', stagger: 0.06, delay: 0.5 });
  }

  const setPhase = (p: number) => {
    let i = 0;
    while (i < 3 && p >= PHASE_AT[i + 1]) i++;
    phases.forEach((ph, k) => ph.classList.toggle('is-active', k === i));
    stageLabel.textContent = PHASES[i];
    sheetLabel.textContent = String(i + 1);
    bar.style.transform = `scaleX(${p})`;
    // dims belong to the drawing phase; they fade as the tower is assembled
    (poster.dims as SVGGElement).style.opacity = String(1 - clamp((p - 0.12) / 0.15));
    hero.classList.toggle('is-scrolled', p > 0.01);
    if (isNarrow()) gsap.set(copy, { opacity: 1 - clamp((p - 0.12) / 0.12), y: -clamp((p - 0.12) / 0.12) * 30 });
  };

  if (!reducedMotion) {
    ScrollTrigger.create({
      trigger: hero,
      start: 'top top',
      end: 'bottom bottom',
      scrub: true,
      onUpdate: self => {
        progress = self.progress;
        setPhase(progress);
        scene?.setProgress(progress);
      },
    });
  } else {
    setPhase(0);
  }

  // WebGL is an enhancement: load after first paint, skip when unsupported
  const gl = (() => {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  })();
  if (gl) {
    // Phase 1 *is* the drawing, so the SVG carries the first screen on its own.
    // The 3D scene (shader compile + environment map) starts on the first sign of
    // intent — scroll, pointer, touch, key — or after the page has been idle a while.
    let started = false;
    const start = async () => {
      if (started) return;
      started = true;
      intents.forEach(ev => window.removeEventListener(ev, start));
      const { createTowerScene } = await import('./scene');
      scene = createTowerScene(canvas, layout, () => hero.classList.add('is-gl'), reducedMotion);
      scene.setProgress(reducedMotion ? 1 : progress);
    };
    const intents = ['scroll', 'wheel', 'pointermove', 'touchstart', 'keydown'];
    intents.forEach(ev => window.addEventListener(ev, start, { passive: true, once: true }));
    window.addEventListener('load', () => setTimeout(() => idle(start, 2000), 4000));
    // fetch the module early (download only), so starting is instant
    idle(() => void import('./scene'), 3000);
  }

  let rt = 0;
  const onResize = () => {
    cancelAnimationFrame(rt);
    rt = requestAnimationFrame(() => {
      const next = heroLayout(stage);
      if (Math.abs(next.w - layout.w) < 2 && Math.abs(next.h - layout.h) < 120) return; // ignore mobile URL-bar jitter
      layout = next;
      poster = drawPoster(svg, layout);
      setPhase(progress);
      scene?.resize(layout);
    });
  };
  window.addEventListener('resize', onResize);
}
