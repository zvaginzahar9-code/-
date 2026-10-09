import { gsap, ScrollTrigger, lenis, lockScroll } from '../core/smooth';
import { $, $$, finePointer, reducedMotion, isNarrow } from '../core/env';

/* Header: solid after the hero starts moving, hides on scroll down, returns on scroll up. */
export function initHeader() {
  const hdr = $('[data-hdr]')!;
  let last = 0;
  const onScroll = (y: number) => {
    hdr.classList.toggle('is-solid', y > 40);
    hdr.classList.toggle('is-hidden', y > last && y > 400 && !document.documentElement.classList.contains('menu-open'));
    last = y;
  };
  if (lenis) lenis.on('scroll', (l: { scroll: number }) => onScroll(l.scroll));
  else window.addEventListener('scroll', () => onScroll(window.scrollY), { passive: true });

  const btn = $<HTMLButtonElement>('[data-menu]')!;
  const nav = $('[data-mnav]')!;
  const set = (open: boolean) => {
    btn.setAttribute('aria-expanded', String(open));
    nav.hidden = !open;
    document.documentElement.classList.toggle('menu-open', open);
    lockScroll(open);
    if (open && !reducedMotion) gsap.from($$('a', nav), { y: 24, opacity: 0, duration: 0.5, ease: 'power3.out', stagger: 0.04 });
  };
  btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
  nav.addEventListener('click', e => (e.target as Element).closest('a') && set(false));
  document.addEventListener('keydown', e => e.key === 'Escape' && !nav.hidden && set(false));
}

/* Crosshair cursor with live "coordinates" over drawings (desktop only). */
export function initCursor() {
  if (!finePointer || reducedMotion) return;
  const c = $('[data-cursor]')!;
  const xy = $('[data-cursor-xy]')!;
  document.documentElement.classList.add('has-cursor');
  const xTo = gsap.quickTo(c, 'x', { duration: 0.18, ease: 'power3' });
  const yTo = gsap.quickTo(c, 'y', { duration: 0.18, ease: 'power3' });
  let zone: Element | null = null;
  window.addEventListener('pointermove', e => {
    xTo(e.clientX);
    yTo(e.clientY);
    const z = (e.target as Element).closest?.('[data-crosshair]') ?? null;
    if (z !== zone) {
      zone = z;
      c.classList.toggle('on', !!z);
    }
    if (z) {
      const r = z.getBoundingClientRect();
      xy.textContent = `x ${Math.round(e.clientX - r.left)}  y ${Math.round(r.bottom - e.clientY)}`;
    }
  });
  $$('.hero__stage, .sheet__draw').forEach(n => n.setAttribute('data-crosshair', ''));
}

/* Mission text lights up word by word as it is read. */
export function initWords() {
  const p = $('[data-words]');
  if (!p) return;
  const words = p.innerHTML.split(/(\s+)/).map(w => (/^\s+$/.test(w) ? w : `<span class="w">${w}</span>`));
  p.innerHTML = words.join('');
  const spans = $$('.w', p);
  if (reducedMotion) {
    spans.forEach(s => s.classList.add('on'));
    return;
  }
  ScrollTrigger.create({
    trigger: p,
    start: 'top 78%',
    end: 'bottom 45%',
    scrub: true,
    onUpdate: self => {
      const n = Math.round(self.progress * spans.length);
      spans.forEach((s, i) => s.classList.toggle('on', i < n));
    },
  });
}

/* Numbers count up once when they enter the frame. */
export function initCounters() {
  for (const el of $$('[data-count]')) {
    const to = Number(el.dataset.count);
    if (reducedMotion) continue;
    const obj = { v: 0 };
    el.textContent = '0';
    ScrollTrigger.create({
      trigger: el,
      start: 'top 88%',
      once: true,
      onEnter: () =>
        gsap.to(obj, {
          v: to,
          duration: to > 1000 ? 1.6 : 1.1,
          ease: 'power2.out',
          onUpdate: () => (el.textContent = Math.round(obj.v).toLocaleString('ru-RU')),
        }),
    });
  }
}

/* Two schools: two conductors converge into one as the section scrolls by. */
export function initSynergy() {
  const svg = $('[data-synergy-lines]');
  if (!svg || reducedMotion) return;
  const paths = $$<SVGPathElement>('path', svg);
  paths.forEach(p => {
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
  });
  const tl = gsap.timeline({ scrollTrigger: { trigger: '[data-synergy] .synergy__board', start: 'top 70%', end: 'bottom 70%', scrub: 0.6 } });
  tl.to(paths.slice(0, 2), { strokeDashoffset: 0, ease: 'none', duration: 1 })
    .to(paths[2], { strokeDashoffset: 0, ease: 'none', duration: 0.5 })
    .from('.synergy__result-name', { scale: 0.8, opacity: 0, duration: 0.3, ease: 'back.out(2)' }, '-=0.2');
}

/* Production photos drift sideways with the scroll (film strip). */
export function initFilm() {
  const track = $('[data-film-track]');
  if (!track || reducedMotion) return;
  gsap.fromTo(
    track,
    { x: () => (isNarrow() ? 0 : window.innerWidth * 0.12) },
    {
      x: () => -(track.scrollWidth - window.innerWidth) + (isNarrow() ? 0 : -window.innerWidth * 0.04),
      ease: 'none',
      scrollTrigger: { trigger: '[data-film]', start: 'top bottom', end: 'bottom top', scrub: 0.4, invalidateOnRefresh: true },
    },
  );
  // inner parallax, so each frame feels like a window onto a deeper space
  $$('img', track).forEach(img =>
    gsap.fromTo(img, { xPercent: -5 }, { xPercent: 5, ease: 'none', scrollTrigger: { trigger: '[data-film]', start: 'top bottom', end: 'bottom top', scrub: true } }),
  );
}

/* Products: the row's photo follows the pointer in a chamfered plate (desktop). */
export function initProducts() {
  const list = $('[data-products] .plist');
  if (!list || !finePointer) return;
  const float = document.createElement('div');
  float.className = 'plist__float';
  document.body.appendChild(float);
  const xTo = gsap.quickTo(float, 'x', { duration: 0.5, ease: 'power3' });
  const yTo = gsap.quickTo(float, 'y', { duration: 0.5, ease: 'power3' });
  const rTo = gsap.quickTo(float, 'rotation', { duration: 0.6, ease: 'power3' });
  let lastX = 0;
  let current = '';
  list.addEventListener('pointermove', e => {
    xTo(e.clientX + 64);
    yTo(e.clientY - 40);
    rTo(gsap.utils.clamp(-6, 6, (e.clientX - lastX) * 0.35));
    lastX = e.clientX;
    const item = (e.target as Element).closest<HTMLElement>('.plist__item');
    const src = item?.dataset.photo ?? '';
    if (src && src !== current) {
      current = src;
      const img = new Image();
      img.src = src;
      img.alt = '';
      float.appendChild(img);
      if (!reducedMotion) gsap.fromTo(img, { clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)', duration: 0.45, ease: 'power3.out' });
      while (float.children.length > 2) float.firstElementChild!.remove();
    }
  });
  list.addEventListener('pointerenter', () => float.classList.add('on'));
  list.addEventListener('pointerleave', () => {
    float.classList.remove('on');
    current = '';
  });
  gsap.set(float, { xPercent: 0, yPercent: -50, scale: 1 });
}
