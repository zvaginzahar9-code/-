const LAT: Record<string, string> = { p: 'п', u: 'у', y: 'у', c: 'с', s: 'с', t: 'т', k: 'к', v: 'в', b: 'б', n: 'н', g: 'г', a: 'а', o: 'о', e: 'е', d: 'д', i: 'и', h: 'х', x: 'х', m: 'м', r: 'р', l: 'л', z: 'з', f: 'ф' };
/** "p110-2", "П 110-2" and "п110‑2" all match "П110-2". */
export const normMark = (s: string) =>
  s.toLowerCase().replace(/[‐‑–—]/g, '-').replace(/\s+/g, '').replace(/[a-z]/g, ch => LAT[ch] ?? ch);

/** Escapes text for HTML templates (catalogue strings are static, but keep templates safe). */
export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
