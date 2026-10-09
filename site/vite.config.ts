import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';

interface Item { slug: string; mark: string; kv: number; H: number | null; h: number | null; L: number | null; mass: number | null; project: string | null }

const fmt = (n: number | null) => (n == null ? '—' : String(n).replace('.', ','));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Bakes the catalog table into the HTML, so it is indexable and works without JS. */
function catalogTable(): Plugin {
  return {
    name: 'catalog-table',
    transformIndexHtml(html) {
      const items: Item[] = JSON.parse(readFileSync(new URL('./src/data/catalog.json', import.meta.url), 'utf8'));
      const rows = items
        .map(
          it =>
            `<tr data-slug="${it.slug}" data-kv="${it.kv}"><th scope="row"><a href="#/opora/${it.slug}">${esc(it.mark)}</a></th><td>${it.kv}</td><td>${fmt(it.H)}</td><td>${fmt(it.h)}</td><td>${fmt(it.L)}</td><td>${it.mass == null ? '—' : it.mass.toLocaleString('ru-RU')}</td><td>${esc(it.project ?? '—')}</td></tr>`,
        )
        .join('');
      return html.replace('<!--CATALOG_ROWS-->', rows);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [catalogTable()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 2048,
  },
  server: { host: true },
  // same security headers as production (vercel.json), so `npm run preview` catches CSP breakage
  preview: {
    headers: Object.fromEntries(
      (JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')).headers[0].headers as { key: string; value: string }[])
        .map(h => [h.key, h.key === 'Content-Security-Policy' ? h.value.replace('; upgrade-insecure-requests', '') : h.value]),
    ),
  },
});
