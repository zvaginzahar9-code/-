export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
export const isNarrow = () => window.innerWidth <= 860;
export const dpr = (max = 2) => Math.min(window.devicePixelRatio || 1, max);

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

/** Run `cb` when the element first comes near the viewport. */
export function whenNear(el: Element, cb: () => void, margin = '400px') {
  const io = new IntersectionObserver(
    entries => {
      if (entries.some(e => e.isIntersecting)) {
        io.disconnect();
        cb();
      }
    },
    { rootMargin: margin },
  );
  io.observe(el);
}

/** Tracks whether an element is on screen; used to pause canvases. */
export function visibility(el: Element, cb: (visible: boolean) => void, margin = '100px') {
  const io = new IntersectionObserver(entries => cb(entries[0].isIntersecting), { rootMargin: margin });
  io.observe(el);
  return () => io.disconnect();
}

export const idle = (cb: () => void, timeout = 1200) =>
  'requestIdleCallback' in window ? (window as any).requestIdleCallback(cb, { timeout }) : setTimeout(cb, 200);

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const fmt = (n: number | null | undefined, digits = 1) =>
  n == null ? '—' : n.toLocaleString('ru-RU', { minimumFractionDigits: Number.isInteger(n) ? 0 : digits, maximumFractionDigits: digits });
