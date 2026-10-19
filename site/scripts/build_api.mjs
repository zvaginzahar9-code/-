// Bundles the assistant endpoint (server/chat.ts) into api/chat.js — the file Vercel deploys
// as a function. The bundle is committed so the function exists before the build starts,
// and `npm run build` regenerates it. tests/bundle.test.ts fails when it is out of date.
import { rolldown } from 'rolldown';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const BANNER = '// GENERATED from server/ by scripts/build_api.mjs — edit the sources, then run `npm run build:api`.';

export async function bundleApi() {
  const build = await rolldown({ input: `${root}server/chat.ts`, external: [/^@anthropic-ai\//, /^node:/], platform: 'node', logLevel: 'warn' });
  const { output } = await build.generate({ format: 'esm', banner: BANNER });
  await build.close();
  return output[0].code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(`${root}api`, { recursive: true });
  writeFileSync(`${root}api/chat.js`, await bundleApi());
  console.log('api/chat.js written');
}
