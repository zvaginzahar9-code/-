// Pre-projects Kazakhstan's outline and the named nodes of the partner's KZ projects into
// SVG coordinates, so the page ships a tiny static path instead of a geo library.
// Usage: node scripts/build_map.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import { geoConicConformal, geoPath } from 'd3-geo';

const topo = JSON.parse(readFileSync(new URL('../node_modules/world-atlas/countries-50m.json', import.meta.url)));
const countries = feature(topo, topo.objects.countries);
const kz = countries.features.find(f => f.properties.name === 'Kazakhstan');

const W = 1000, H = 600;
const projection = geoConicConformal().parallels([45, 52]).rotate([-67, 0]).fitExtent([[10, 10], [W - 10, H - 10]], kz);
const path = geoPath(projection);
const round = d => d.replace(/(\d+\.\d{1})\d+/g, '$1');

// Approximate coordinates of settlements / substations named in the presentation.
const nodes = {
  karaganda: ['Караганда', 73.10, 49.80],
  semey: ['Семей', 80.23, 50.41],
  shulba: ['Шульбинская ГЭС', 81.07, 50.38],
  aktogay: ['Актогай', 79.62, 46.95],
  taldykorgan: ['Талдыкорган', 78.37, 45.02],
  alma: ['Алма', 76.89, 43.35],
  ekibastuz: ['Экибастуз', 75.32, 51.72],
  ustkam: ['Усть-Каменогорск', 82.62, 49.95],
  tulkubas: ['Тюлькубас', 70.29, 42.50],
  burnoe: ['Бурное', 70.85, 42.60],
  kempirsay: ['Кемпирсай', 58.45, 50.27],
  akzhar: ['Акжар', 57.85, 50.05],
  aktobe: ['Актюбинская', 57.17, 50.28],
  dostyk: ['Достык', 82.48, 45.25],
  uralsk: ['Уральская', 51.37, 51.23],
  inder: ['Индер', 51.78, 48.55],
  karabatan: ['Карабатан', 51.95, 47.17],
  kulsary: ['Кульсары', 54.02, 46.95],
  tengiz: ['Тенгиз', 53.40, 46.10],
  vko: ['Восточно-Казахстанская обл.', 81.5, 49.2],
  almobl: ['Алматинская обл.', 77.8, 44.9],
};
const pts = {};
for (const [k, [name, lon, lat]] of Object.entries(nodes)) {
  const [x, y] = projection([lon, lat]);
  pts[k] = { name, x: +x.toFixed(1), y: +y.toFixed(1) };
}
const hq = pts.karaganda;
writeFileSync(new URL('../src/data/kz-map.json', import.meta.url), JSON.stringify({ w: W, h: H, d: round(path(kz)), nodes: pts, hq }, null, 0));
console.log('ok', Object.keys(pts).length, 'nodes; path chars', path(kz).length);
