import map from '../data/kz-map.json';
import { gsap } from '../core/smooth';
import { $, $$, reducedMotion } from '../core/env';

type Node = { name: string; x: number; y: number };
const nodes = map.nodes as Record<string, Node>;
const ALWAYS = new Set(['semey', 'aktogay', 'taldykorgan', 'alma', 'ekibastuz', 'ustkam', 'tulkubas', 'aktobe', 'uralsk', 'tengiz', 'dostyk']);
const AREAS = new Set(['vko', 'almobl']);
// the few labels still shown on a phone, where the map is ~350px wide
const MAJOR = new Set(['uralsk', 'aktobe', 'ustkam', 'alma', 'tengiz']);

export function initMap() {
  const host = $('[data-map]');
  const list = $('[data-projects]');
  if (!host || !list) return;
  const items = $$<HTMLLIElement>('li', list);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `-20 -20 ${map.w + 40} ${map.h + 40}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Схема: трассы проектов на карте Казахстана, офис в Караганде');
  const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, String(attrs[k]));
    parent.appendChild(n);
    return n;
  };
  mk('path', { d: map.d, class: 'kz' });

  const routes: SVGElement[] = [];
  const used = new Set<string>();
  items.forEach((li, i) => {
    const keys = (li.dataset.route ?? '').split(',').filter(Boolean);
    keys.forEach(k => used.add(k));
    let el: SVGElement;
    if (keys.length === 1 && AREAS.has(keys[0])) {
      const n = nodes[keys[0]];
      el = mk('circle', { cx: n.x, cy: n.y, r: 26, class: 'area' }) as SVGElement;
    } else if (keys.length === 1) {
      // a short line from a solar plant to the substation: drawn as a stub
      const n = nodes[keys[0]];
      el = mk('path', { d: `M${n.x - 34} ${n.y + 18}L${n.x} ${n.y}`, class: 'route' }) as SVGElement;
    } else {
      const pts = keys.map(k => nodes[k]);
      el = mk('path', { d: 'M' + pts.map(p => `${p.x} ${p.y}`).join('L'), class: 'route' }) as SVGElement;
    }
    el.dataset.i = String(i);
    routes.push(el);
  });

  for (const k of used) {
    if (AREAS.has(k)) continue;
    const n = nodes[k];
    const g = mk('g', { class: MAJOR.has(k) ? 'node is-major' : 'node', 'data-k': k });
    mk('circle', { cx: n.x, cy: n.y, r: 4 }, g);
    if (ALWAYS.has(k)) {
      const left = n.x > map.w * 0.7;
      const t = mk('text', { x: n.x + (left ? -9 : 9), y: n.y + 4, 'text-anchor': left ? 'end' : 'start' }, g);
      t.textContent = n.name;
    }
  }
  const hq = map.hq as Node;
  const g = mk('g', { class: 'hq' });
  mk('rect', { x: hq.x - 6, y: hq.y - 6, width: 12, height: 12, transform: `rotate(45 ${hq.x} ${hq.y})` }, g);
  const t = mk('text', { x: hq.x + 12, y: hq.y + 5 }, g);
  t.textContent = 'Караганда — завод';
  host.appendChild(svg);

  // routes are laid like cable: drawn one after another when the map scrolls in
  const lines = routes.filter(r => r.tagName === 'path') as unknown as SVGPathElement[];
  if (!reducedMotion) {
    lines.forEach(p => {
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len}`;
      p.style.strokeDashoffset = `${len}`;
    });
    const tl = gsap.timeline({ scrollTrigger: { trigger: host, start: 'top 75%', once: true } });
    tl.to(lines, { strokeDashoffset: 0, duration: 1.1, ease: 'power2.inOut', stagger: 0.14 })
      .from($$('.area', svg), { scale: 0, transformOrigin: 'center', duration: 0.5, ease: 'back.out(2)', stagger: 0.1 }, '-=0.6')
      .from($$('.node, .hq', svg), { opacity: 0, duration: 0.4, stagger: 0.02 }, 0.2);
  }

  const set = (i: number | null) => {
    routes.forEach((r, k) => r.classList.toggle('is-on', k === i));
    items.forEach((li, k) => li.classList.toggle('is-on', k === i));
  };
  items.forEach((li, i) => {
    li.tabIndex = 0;
    li.addEventListener('pointerenter', () => set(i));
    li.addEventListener('focus', () => set(i));
    li.addEventListener('pointerleave', () => set(null));
    li.addEventListener('blur', () => set(null));
  });
}
