import './styles/main.css';
import { initSmooth, ScrollTrigger } from './core/smooth';
import { initHero } from './hero/hero';
import { initWires } from './ui/wires';
import { initHeader, initCursor, initWords, initCounters, initSynergy, initFilm, initProducts } from './ui/sections';
import { initZinc } from './ui/zinc';
import { initForm } from './ui/form';
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
let catalog: Promise<void> | null = null;
const loadCatalog = (h = '') => (catalog ??= import('./catalog').then(m => m.boot(h)));
// a shared link to a tower loads the catalogue right away; otherwise when it gets close
if (hash.startsWith('#/opora/')) loadCatalog(hash);
else whenNear($('[data-catalog]')!, () => loadCatalog(), '900px');
// a tower link followed before the catalogue chunk has loaded
window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#/opora/') && !catalog) loadCatalog(location.hash);
});
whenNear($('[data-exp]')!, () => import('./ui/map').then(m => m.initMap()), '600px');
initForm();
initWires();
initCursor();

// layout settles after fonts load; recompute trigger positions once
document.fonts?.ready.then(() => ScrollTrigger.refresh());
window.addEventListener('load', () => ScrollTrigger.refresh());
