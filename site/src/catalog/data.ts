// the import attribute lets Node load this module as-is (the assistant API reads the same catalogue)
import raw from '../data/catalog.json' with { type: 'json' };

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

export { normMark, esc } from './text';

export const kvLabel = (kv: number) => `Стальная опора ВЛ ${kv} кВ`;
