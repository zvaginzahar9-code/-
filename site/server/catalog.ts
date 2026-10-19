import { towers, bySlug, normMark, type Tower } from '../src/catalog/data.ts';
import type { CompareRow, ProductCard, ProductDetails } from '../src/assistant/protocol.ts';

/**
 * Catalogue retrieval for the assistant. Reads the same records the site renders
 * (src/data/catalog.json); nothing here invents or derives product data.
 */

/** Caveats recorded with the source data (see README, «Откуда контент»). */
const NOTES: Record<string, string> = {
  '1p35-2': 'В каталоге масса указана как 20,89 кг — значение вызывает сомнение и уточняется при расчёте.',
};

export interface SearchInput {
  query: string | null;
  voltage_kv: number | null;
  height_min_m: number | null;
  height_max_m: number | null;
  mass_max_kg: number | null;
  sort: 'height_asc' | 'height_desc' | 'mass_asc' | 'mass_desc' | null;
  limit: number | null;
}

export const toCard = (t: Tower): ProductCard => ({
  slug: t.slug,
  mark: t.mark,
  kv: t.kv,
  H: t.H,
  h: t.h,
  L: t.L,
  mass: t.mass,
  wire: t.wire,
  project: t.project,
  image: t.svgTower,
  ...(NOTES[t.slug] ? { note: NOTES[t.slug] } : {}),
});

export const toDetails = (t: Tower): ProductDetails => ({ ...toCard(t), specs: t.specs });

const haystacks = new Map(
  towers.map(t => [t.slug, normMark([t.mark, t.wire ?? '', t.project ?? '', ...t.specs.map(s => s.value)].join(' '))]),
);

/** Finds a tower by slug or by mark in any spelling ("p110-2", "П 110-2"). */
export function resolveTower(ref: string): Tower | null {
  const raw = ref.trim();
  if (!raw || raw.length > 40) return null;
  const direct = bySlug.get(raw.toLowerCase());
  if (direct) return direct;
  const n = normMark(raw);
  return towers.find(t => normMark(t.mark) === n) ?? null;
}

/** Marks that are close to an unknown reference, to offer instead of guessing. */
export function suggest(ref: string, max = 5): string[] {
  const n = normMark(ref.trim()).slice(0, 40);
  if (n.length < 2) return [];
  return towers.filter(t => normMark(t.mark).includes(n) || n.includes(normMark(t.mark))).slice(0, max).map(t => t.mark);
}

export function searchCatalog(input: SearchInput): { items: ProductCard[]; total: number } {
  const q = input.query ? normMark(input.query.trim()).slice(0, 80) : '';
  const tokens = input.query ? input.query.trim().slice(0, 80).split(/\s+/).map(normMark).filter(Boolean) : [];
  let found = towers.filter(t => {
    if (input.voltage_kv != null && t.kv !== input.voltage_kv) return false;
    if (input.height_min_m != null && t.H < input.height_min_m) return false;
    if (input.height_max_m != null && t.H > input.height_max_m) return false;
    // a tower with no recorded mass cannot satisfy a mass limit
    if (input.mass_max_kg != null && (t.mass == null || t.mass > input.mass_max_kg)) return false;
    if (!q) return true;
    if (normMark(t.mark).includes(q)) return true;
    const hay = haystacks.get(t.slug)!;
    return tokens.every(tok => hay.includes(tok));
  });
  if (input.sort) {
    const [key, dir] = input.sort.split('_') as ['height' | 'mass', 'asc' | 'desc'];
    const val = (t: Tower) => (key === 'height' ? t.H : t.mass);
    // records without the value go last in either direction
    found = [...found].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return dir === 'asc' ? x - y : y - x;
    });
  } else if (q) {
    // an exact mark first, then marks that start with the query
    const rank = (t: Tower) => (normMark(t.mark) === q ? 0 : normMark(t.mark).startsWith(q) ? 1 : 2);
    found = [...found].sort((a, b) => rank(a) - rank(b));
  }
  const limit = Math.min(12, Math.max(1, Math.trunc(input.limit ?? 6)));
  return { items: found.slice(0, limit).map(toCard), total: found.length };
}

export function compareTowers(list: Tower[]): { items: ProductCard[]; rows: CompareRow[] } {
  const labels: string[] = [];
  for (const t of list) for (const s of t.specs) if (!labels.includes(s.label)) labels.push(s.label);
  const rows = labels
    .filter(l => l !== 'Наименование изделия')
    .map(label => {
      const values = list.map(t => t.specs.find(s => s.label === label)?.value ?? null);
      return { label, values, differs: new Set(values).size > 1 };
    });
  return { items: list.map(toCard), rows };
}

export const catalogSize = towers.length;
