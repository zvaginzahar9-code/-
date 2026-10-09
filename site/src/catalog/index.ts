import { initCatalog } from './catalog';
import { initSheet, openFromLocation } from './sheet';

/** Catalogue, product sheet and comparison: loaded as one chunk when the catalogue nears the viewport. */
export function boot(hash: string) {
  initCatalog();
  initSheet();
  openFromLocation(hash);
}
