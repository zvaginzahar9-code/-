import { gsap, lockScroll } from '../core/smooth';
import { $, reducedMotion } from '../core/env';
import { bySlug } from './data';

export const compareSet = new Set<string>();
const MAX = 3;

export function toggleCompare(slug: string) {
  if (compareSet.has(slug)) compareSet.delete(slug);
  else {
    if (compareSet.size >= MAX) compareSet.delete(compareSet.values().next().value!);
    compareSet.add(slug);
  }
  renderTray();
}

function renderTray() {
  const tray = $('[data-tray]')!;
  const marks = [...compareSet].map(s => bySlug.get(s)!.mark);
  tray.hidden = marks.length === 0;
  $('[data-tray-list]')!.textContent = marks.length ? `${marks.join(', ')}${marks.length < 2 ? ' — добавьте ещё одну' : ''}` : '';
  ($('[data-compare-open]') as HTMLButtonElement).disabled = marks.length < 2;
}

function openCompare() {
  const box = $('[data-cmp]')!;
  const items = [...compareSet].map(s => bySlug.get(s)!);
  if (items.length < 2) return;
  const stage = $('[data-cmp-stage]')!;
  box.hidden = false;
  lockScroll(true);
  const hpx = stage.clientHeight - 70;
  const ppm = hpx / Math.max(...items.map(t => t.H));
  stage.innerHTML = items
    .map(t => {
      const [x0, y0, x1, y1] = t.draw.tower;
      const k = (t.H * ppm) / (y1 - y0);
      const h = (y1 - y0 + 2) * k;
      const w = (x1 - x0 + 2) * k;
      return `<figure><img src="${t.svgTower}" alt="Чертёж опоры ${t.mark}" style="height:${h}px;width:${w}px"><figcaption>${t.mark}</figcaption></figure>`;
    })
    .join('');
  // union of all labels, in the order of the first tower's table
  const labels: string[] = [];
  for (const t of items) for (const s of t.specs) if (!labels.includes(s.label)) labels.push(s.label);
  const val = (slug: string, l: string) => bySlug.get(slug)!.specs.find(s => s.label === l)?.value ?? '—';
  const rows = labels
    .filter(l => l !== 'Наименование изделия')
    .map(l => {
      const vals = items.map(t => val(t.slug, l));
      const diff = new Set(vals).size > 1;
      return `<tr class="${diff ? 'is-diff' : ''}"><th scope="row">${l}</th>${vals.map(v => `<td>${v}</td>`).join('')}</tr>`;
    })
    .join('');
  $('[data-cmp-table]')!.innerHTML = `<table><thead><tr><th></th>${items.map(t => `<th scope="col">${t.mark}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  ($('[data-cmp-close]') as HTMLButtonElement).focus();
  if (!reducedMotion) {
    gsap.from(box, { opacity: 0, duration: 0.3 });
    gsap.from('[data-cmp-stage] figure', { yPercent: 100, duration: 0.9, ease: 'expo.out', stagger: 0.08, delay: 0.1 });
  }
}

function closeCompare() {
  $('[data-cmp]')!.hidden = true;
  lockScroll(false);
}

export function initCompare() {
  $('[data-compare-open]')!.addEventListener('click', openCompare);
  $('[data-compare-clear]')!.addEventListener('click', () => {
    compareSet.clear();
    renderTray();
  });
  $('[data-cmp-close]')!.addEventListener('click', closeCompare);
  $('[data-cmp]')!.addEventListener('keydown', e => e.key === 'Escape' && closeCompare());
  renderTray();
}
