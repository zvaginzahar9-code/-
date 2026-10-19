import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error plain script without types
import { bundleApi } from '../scripts/build_api.mjs';

it('api/chat.js (the deployed function) is built from the current server/ sources', async () => {
  const committed = readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
  expect(committed === (await bundleApi()), 'api/chat.js is stale — run `npm run build:api`').toBe(true);
});

it('the deployed function contains no test double', () => {
  const committed = readFileSync(new URL('../api/chat.js', import.meta.url), 'utf8');
  expect(committed).not.toMatch(/ASSISTANT_FAKE|demoClient|scriptedClient/);
});
