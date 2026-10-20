import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error plain script without types
import { bundleApi } from '../scripts/build_api.mjs';

for (const name of ['chat', 'tts']) {
  it(`api/${name}.js (a deployed function) is built from the current server/ sources`, async () => {
    const committed = readFileSync(new URL(`../api/${name}.js`, import.meta.url), 'utf8');
    expect(committed === (await bundleApi(name)), `api/${name}.js is stale — run \`npm run build:api\``).toBe(true);
  });

  it(`api/${name}.js contains no test double`, () => {
    const committed = readFileSync(new URL(`../api/${name}.js`, import.meta.url), 'utf8');
    expect(committed).not.toMatch(/ASSISTANT_FAKE|demoClient|scriptedClient/);
  });
}
