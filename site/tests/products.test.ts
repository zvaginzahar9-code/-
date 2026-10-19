import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import raw from '../src/data/products.json' with { type: 'json' };

interface Cell { t: string }
interface Item { slug: string; name: string; mark: string; draw: string | null; series: boolean; note: string; tables: Cell[][][] }
const cats = (raw as unknown as { categories: { id: string; title: string; groups: { title: string; items: Item[] }[] }[] }).categories;
const items = cats.flatMap(c => c.groups.flatMap(g => g.items));
const pub = join(__dirname, '..', 'public', 'products');

describe('product catalogue data', () => {
  it('has every category the client asked for', () => {
    expect(cats.map(c => c.title)).toEqual(['Прожекторные мачты', 'Молниеотводы', 'Порталы ОРУ', 'Опоры контактной сети', 'Свайные фундаменты', 'Металлоконструкции 0,4–35 кВ']);
    const hw = cats.find(c => c.id === 'hardware')!.groups.map(g => g.title).join(' ');
    for (const s of ['Траверсы', 'Надставки', 'Крюки', 'Крепления укоса', 'Оголовки', 'Стяжки', 'Хомуты', 'Оттяжки', 'Кронштейны', 'Накладки']) expect(hw).toContain(s);
    const contact = cats.find(c => c.id === 'contact')!.groups.map(g => g.title);
    expect(contact).toHaveLength(6);
  });

  it('slugs are unique and safe for a URL hash', () => {
    const slugs = items.map(i => i.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[\w-]+$/);
  });

  it('every referenced drawing and its card preview are on disk', () => {
    for (const i of items.filter(i => i.draw)) {
      expect(existsSync(join(pub, `${i.draw}.svg`)), i.draw!).toBe(true);
      expect(existsSync(join(pub, `${i.draw}-s.webp`)), i.draw!).toBe(true);
    }
  });

  it('carries nothing of the source company: no name, phone, city, prices or sales talk', () => {
    const text = JSON.stringify(raw);
    for (const bad of [/Завод Стальных/i, /ЗСК/, /343/, /Екатеринбург/i, /руб\./i, /купить/i, /по РФ/i, /обращайтесь/i]) expect(text).not.toMatch(bad);
  });

  it('a series drawing is flagged when several marks share it', () => {
    const pms = cats.find(c => c.id === 'masts')!.groups[0].items;
    expect(pms.every(i => i.series)).toBe(true);
  });

  it('no table is left without any value', () => {
    for (const i of items) for (const t of i.tables) expect(t.slice(1).some(r => r.slice(1).some(c => c.t && c.t !== '—')), i.slug).toBe(true);
  });
});
