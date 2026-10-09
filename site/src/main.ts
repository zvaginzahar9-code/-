import './styles/main.css';
import { initSmooth, ScrollTrigger } from './core/smooth';
import { initHero } from './hero/hero';
import { initWires } from './ui/wires';
import { initHeader, initCursor, initWords, initCounters, initSynergy, initFilm, initProducts } from './ui/sections';
import { initZinc } from './ui/zinc';
import { initMap } from './ui/map';
import { initForm } from './ui/form';
import { initCatalog } from './catalog/catalog';
import { initSheet, openFromLocation } from './catalog/sheet';
import { $, whenNear } from './core/env';

document.documentElement.classList.remove('no-js');
const hash = location.hash;

initSmooth();
initHeader();
initHero();
initWords();
initCounters();
initSynergy();
initFilm();
initProducts();
// heavier sections are built when they approach the viewport
whenNear($('[data-zinc]')!, initZinc, '600px');
let catalogBuilt = false;
const buildCatalog = () => {
  if (catalogBuilt) return;
  catalogBuilt = true;
  initCatalog();
};
// a shared link to a tower builds the catalogue right away; otherwise when it gets close
if (hash.startsWith('#/opora/')) buildCatalog();
else whenNear($('[data-catalog]')!, buildCatalog, '900px');
initSheet();
whenNear($('[data-exp]')!, initMap, '600px');
initForm();
initWires();
initCursor();

// layout settles after fonts load; recompute trigger positions once
document.fonts?.ready.then(() => ScrollTrigger.refresh());
window.addEventListener('load', () => ScrollTrigger.refresh());
openFromLocation(hash);
