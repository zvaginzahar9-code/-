// node scripts/thumbs.cjs <dir> [size]  — renders every <name>.svg in <dir> to <name>-s.webp:
// a light preview for the catalogue cards (the sheet loads the full vector drawing).
// Fits the drawing into a size×size box on white: the cards blend it with `multiply`, so white
// vanishes into the paper and only the lines remain.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
(async () => {
  const [dir, sArg] = process.argv.slice(2);
  const S = +sArg || 480;
  const exe = process.env.PW_CHROME || path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
  const b = await chromium.launch(fs.existsSync(exe) ? { executablePath: exe } : {});
  const p = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.svg') && (process.env.FORCE || !fs.existsSync(path.join(dir, f.replace(/\.svg$/, '-s.webp')))));
  for (const f of files) {
    const svg = fs.readFileSync(path.join(dir, f), 'utf8');
    const [, , w, h] = svg.match(/viewBox="([\d.\s-]+)"/)[1].trim().split(/\s+/).map(Number);
    const k = S / Math.max(w, h);
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
    await p.setViewportSize({ width: W, height: H });
    await p.setContent(`<html><body style="margin:0;background:#fff">${svg.replace('<svg ', `<svg style="display:block;width:${W}px;height:${H}px" `)}</body></html>`);
    const png = await p.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(dir, f.replace(/\.svg$/, '-s.png')), png);
  }
  console.log('rendered', files.length);
  await b.close();
})();
