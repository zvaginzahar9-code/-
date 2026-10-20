// Bundles the assistant endpoints into api/*.js — the files Vercel deploys as functions:
//   server/chat.ts      -> api/chat.js  (the answer, streamed)
//   server/tts-entry.ts -> api/tts.js   (the neural voice)
// The bundles are committed so the functions exist before the build starts, and
// `npm run build` regenerates them. tests/bundle.test.ts fails when one is out of date.
import { rolldown } from 'rolldown';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const BANNER = '// GENERATED from server/ by scripts/build_api.mjs — edit the sources, then run `npm run build:api`.';
export const ENTRIES = { chat: 'server/chat.ts', tts: 'server/tts-entry.ts' };

export async function bundleApi(name = 'chat') {
  const build = await rolldown({ input: `${root}${ENTRIES[name]}`, external: [/^@anthropic-ai\//, /^node:/], platform: 'node', logLevel: 'warn' });
  const { output } = await build.generate({ format: 'esm', banner: BANNER });
  await build.close();
  return output[0].code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(`${root}api`, { recursive: true });
  for (const name of Object.keys(ENTRIES)) {
    writeFileSync(`${root}api/${name}.js`, await bundleApi(name));
    console.log(`api/${name}.js written`);
  }
}
