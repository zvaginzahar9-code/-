import raw from '../data/catalog.json';

export interface Spec { label: string; value: string }
export interface Tower {
  slug: string;
  mark: string;
  kv: number;
  /** 1:1 vector redraw of the scheme with all its dimensions (scripts/trace.py) */
  svg: string;
  /** the same drawing, tower members only, cropped to the tower */
  svgTower: string;
  /** drawing size and the tower box inside it (x0, y0, x1, y1), in drawing units */
  draw: { w: number; h: number; tower: [number, number, number, number] };
  H: number;
  h: number | null;
  L: number | null;
  mass: number | null;
  wire: string | null;
  project: string | null;
  specs: Spec[];
}

export const towers = raw as unknown as Tower[];
export const bySlug = new Map(towers.map(t => [t.slug, t]));
export const maxH = Math.max(...towers.map(t => t.H));
export const KV = [35, 110, 220, 330, 500];

const LAT: Record<string, string> = { p: 'п', u: 'у', y: 'у', c: 'с', s: 'с', t: 'т', k: 'к', v: 'в', b: 'б', n: 'н', g: 'г', a: 'а', o: 'о', e: 'е', d: 'д', i: 'и', h: 'х', x: 'х', m: 'м', r: 'р', l: 'л', z: 'з', f: 'ф' };
/** "p110-2", "П 110-2" and "п110‑2" all match "П110-2". */
export const normMark = (s: string) =>
  s.toLowerCase().replace(/[‐‑–—]/g, '-').replace(/\s+/g, '').replace(/[a-z]/g, ch => LAT[ch] ?? ch);

export const kvLabel = (kv: number) => `Стальная опора ВЛ ${kv} кВ`;
