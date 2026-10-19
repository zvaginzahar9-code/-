// Redraws every scheme listed in research/zavsk/to_trace.txt into public/products/ (4 at a time).
// node scripts/trace_all.mjs <research_dir>
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const research = process.argv[2];
const src = join(research, 'zavsk', 'img');
const out = join(site, 'public', 'products');
const names = readFileSync(join(research, 'zavsk', 'to_trace.txt'), 'utf8').split(/\r?\n/).filter(Boolean)
  .filter(n => process.env.FORCE || !existsSync(join(out, n.replace(/\.[^.]+$/, '.svg'))));
const chunks = Array.from({ length: 4 }, (_, i) => names.filter((_, j) => j % 4 === i)).filter(c => c.length);
console.log('to redraw', names.length);
await Promise.all(chunks.map(chunk => new Promise((res, rej) => {
  const p = spawn('python', ['-I', join(site, 'scripts', 'trace_items.py'), src, out, ...chunk], { stdio: 'inherit' });
  p.on('exit', code => (code ? rej(new Error(`trace exited ${code}`)) : res()));
})));
console.log('done');
