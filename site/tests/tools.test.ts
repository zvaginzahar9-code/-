import { describe, expect, it } from 'vitest';
import raw from '../src/data/catalog.json' with { type: 'json' };
import { compareTowers, resolveTower, searchCatalog, suggest } from '../server/catalog';
import { runTool, toolDefinitions } from '../server/tools';
import type { ServerEvent } from '../src/assistant/protocol';

const catalog = raw as { slug: string; mark: string; kv: number; H: number; mass: number | null; project: string | null; specs: { label: string; value: string }[] }[];
const none = { query: null, voltage_kv: null, height_min_m: null, height_max_m: null, mass_max_kg: null, sort: null, limit: null };
const event = <T extends ServerEvent['t']>(events: ServerEvent[] | undefined, t: T) => events?.find(e => e.t === t) as Extract<ServerEvent, { t: T }> | undefined;

describe('product search', () => {
  it('returns real catalogue records for a voltage class', () => {
    const r = searchCatalog({ ...none, voltage_kv: 110, limit: 12 });
    expect(r.total).toBe(catalog.filter(t => t.kv === 110).length);
    for (const item of r.items) {
      const source = catalog.find(t => t.slug === item.slug)!;
      expect(item).toMatchObject({ mark: source.mark, kv: 110, H: source.H, mass: source.mass, project: source.project });
    }
  });

  it('finds a mark written in Latin letters, with spaces or another dash', () => {
    for (const q of ['p110-2', 'П 110-2', 'п110‑2']) expect(searchCatalog({ ...none, query: q }).items[0].mark).toBe('П110-2');
    expect(resolveTower('p110-2')?.mark).toBe('П110-2');
    expect(resolveTower('u220-2t')?.slug).toBe('u220-2t');
  });

  it('applies numeric limits and sorting', () => {
    const r = searchCatalog({ ...none, voltage_kv: 220, height_max_m: 30, sort: 'mass_asc', limit: 12 });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every(i => i.kv === 220 && i.H <= 30)).toBe(true);
    const masses = r.items.map(i => i.mass!).filter(m => m != null);
    expect(masses).toEqual([...masses].sort((a, b) => a - b));
  });

  it('reports an empty result instead of inventing one', () => {
    expect(searchCatalog({ ...none, query: 'несуществующая-999' })).toEqual({ items: [], total: 0 });
    const out = runTool('search_catalog', { ...none, query: 'несуществующая-999' });
    expect(out.isError).toBeUndefined();
    expect(out.result).toMatchObject({ total: 0, items: [] });
    expect(event(out.events, 'products')).toEqual({ t: 'products', items: [], total: 0 });
  });

  it('caps the number of records', () => {
    expect(searchCatalog({ ...none, limit: 500 }).items).toHaveLength(12);
    expect(searchCatalog({ ...none }).items).toHaveLength(6);
  });
});

describe('missing product information', () => {
  it('keeps absent values as null and never fills them in', () => {
    const noProject = catalog.find(t => t.project === null)!;
    const out = runTool('get_tower_details', { mark: noProject.mark });
    expect((out.result as { project: unknown }).project).toBeNull();
    expect(event(out.events, 'details')!.item.project).toBeNull();
  });

  it('passes on the caveat recorded with the source data', () => {
    const out = runTool('get_tower_details', { mark: '1П35-2' });
    expect((out.result as { note: string }).note).toContain('20,89');
  });

  it('refuses an unknown mark and offers real ones', () => {
    const out = runTool('get_tower_details', { mark: 'П110-99' });
    expect(out.isError).toBe(true);
    expect(out.events).toBeUndefined();
    for (const m of suggest('П110')) expect(catalog.some(t => t.mark === m)).toBe(true);
  });
});

describe('product comparison', () => {
  it('uses the catalogue values of each tower, in order', () => {
    const [a, b] = [resolveTower('П110-2')!, resolveTower('У110-2')!];
    const { rows, items } = compareTowers([a, b]);
    expect(items.map(i => i.mark)).toEqual(['П110-2', 'У110-2']);
    for (const row of rows) {
      expect(row.values[0]).toBe(a.specs.find(s => s.label === row.label)?.value ?? null);
      expect(row.values[1]).toBe(b.specs.find(s => s.label === row.label)?.value ?? null);
      expect(row.differs).toBe(row.values[0] !== row.values[1]);
    }
    expect(rows.some(r => r.label === 'Наименование изделия')).toBe(false);
  });

  it('marks a characteristic one tower lacks as null', () => {
    const withExtra = catalog.find(t => t.specs.some(s => s.label === 'Косогорность h1, м'))!;
    const without = catalog.find(t => !t.specs.some(s => s.label === 'Косогорность h1, м'))!;
    const row = compareTowers([resolveTower(withExtra.slug)!, resolveTower(without.slug)!]).rows.find(r => r.label === 'Косогорность h1, м')!;
    expect(row.values[0]).not.toBeNull();
    expect(row.values[1]).toBeNull();
  });

  it('rejects one tower, duplicates, too many and unknown marks', () => {
    expect(runTool('compare_towers', { marks: ['П110-2'] }).isError).toBe(true);
    expect(runTool('compare_towers', { marks: ['П110-2', 'p110-2'] }).isError).toBe(true);
    expect(runTool('compare_towers', { marks: ['П110-1', 'П110-2', 'П110-3', 'П110-4'] }).isError).toBe(true);
    const out = runTool('compare_towers', { marks: ['П110-2', 'ХХХ-1'] });
    expect(out.isError).toBe(true);
    expect((out.result as { unknown: string[] }).unknown).toEqual(['ХХХ-1']);
    expect(out.events).toBeUndefined();
  });
});

describe('incorrect or incomplete tool arguments', () => {
  const bad: [string, unknown][] = [
    ['search_catalog', { ...none, voltage_kv: 750 }],
    ['search_catalog', { ...none, sort: 'price' }],
    ['search_catalog', { ...none, height_max_m: 'высокая' }],
    ['search_catalog', { ...none, query: { $ne: null } }],
    ['get_tower_details', {}],
    ['get_tower_details', { mark: 42 }],
    ['get_tower_details', { mark: 'П'.repeat(200) }],
    ['open_tower_sheet', { mark: '../../etc/passwd' }],
    ['go_to_section', { section: 'admin' }],
    ['go_to_section', {}],
    ['filter_catalog', { voltage_kv: 1150, mark_query: null, view: null }],
    ['filter_catalog', { voltage_kv: null, mark_query: null, view: 'grid' }],
    ['open_comparison', { marks: 'П110-2' }],
    ['prepare_inquiry', { items: [{ mark: 'П110-2', quantity: -5 }], note: null }],
    ['prepare_inquiry', { items: [{ mark: 'П110-2', quantity: 1.5 }], note: null }],
    ['prepare_inquiry', { items: [], note: null }],
    ['prepare_inquiry', { items: 'все', note: null }],
    ['search_catalog', null],
    ['search_catalog', ['П110-2']],
  ];
  it.each(bad)('%s rejects %j without side effects', (name, input) => {
    const out = runTool(name, input);
    expect(out.isError).toBe(true);
    expect(out.events).toBeUndefined();
    expect(typeof (out.result as { error: string }).error).toBe('string');
  });
});

describe('unauthorized actions', () => {
  it('exposes only the declared tools', () => {
    expect(toolDefinitions.map(t => t.name).sort()).toEqual(
      ['compare_towers', 'filter_catalog', 'get_tower_details', 'go_to_section', 'open_comparison', 'open_tower_sheet', 'prepare_inquiry', 'search_catalog'].sort(),
    );
  });

  it.each(['run_sql', 'execute_shell', 'submit_form', 'fetch_url', '__proto__', 'constructor'])('refuses the undeclared tool %s', name => {
    const out = runTool(name, { query: 'DROP TABLE towers' });
    expect(out.isError).toBe(true);
    expect(out.events).toBeUndefined();
  });

  it('every tool schema is closed to extra properties', () => {
    for (const t of toolDefinitions) expect(t.input_schema.additionalProperties).toBe(false);
  });
});

describe('navigation actions', () => {
  it('opens a sheet only for a tower that exists, by its real slug', () => {
    const out = runTool('open_tower_sheet', { mark: 'у110-2тс' });
    expect(event(out.events, 'action')!.action).toEqual({ kind: 'open_tower', slug: 'u110-2ts', mark: 'У110-2ТС' });
  });

  it('scrolls only to sections the site has', () => {
    expect(event(runTool('go_to_section', { section: 'request' }).events, 'action')!.action).toEqual({ kind: 'section', section: 'request' });
  });

  it('builds a catalogue filter command', () => {
    const out = runTool('filter_catalog', { voltage_kv: 500, mark_query: null, view: 'table' });
    expect(event(out.events, 'action')!.action).toEqual({ kind: 'filter', kv: 500, query: null, view: 'table' });
    expect((out.result as { towers_in_voltage_class: number }).towers_in_voltage_class).toBe(catalog.filter(t => t.kv === 500).length);
  });

  it('opens the comparison with resolved slugs', () => {
    const out = runTool('open_comparison', { marks: ['p110-2', 'У110-2'] });
    expect(event(out.events, 'action')!.action).toEqual({ kind: 'compare', slugs: ['p110-2', 'u110-2'], marks: ['П110-2', 'У110-2'] });
  });
});

describe('inquiry', () => {
  it('produces a draft only; the result says nothing was sent', () => {
    const out = runTool('prepare_inquiry', { items: [{ mark: 'П110-2', quantity: 40 }, { mark: 'У110-2', quantity: null }], note: 'ВЛ 110 кВ, Карагандинская область' });
    expect(event(out.events, 'inquiry')!.draft).toEqual({
      items: [
        { slug: 'p110-2', mark: 'П110-2', quantity: 40 },
        { slug: 'u110-2', mark: 'У110-2', quantity: null },
      ],
      note: 'ВЛ 110 кВ, Карагандинская область',
    });
    expect((out.result as { status: string }).status).toMatch(/только после нажатия/);
    expect(out.events!.every(e => e.t === 'inquiry')).toBe(true);
  });

  it('does not draft a request for a tower that is not in the catalogue', () => {
    const out = runTool('prepare_inquiry', { items: [{ mark: 'П999-1', quantity: 3 }], note: null });
    expect(out.isError).toBe(true);
    expect(out.events).toBeUndefined();
  });
});
