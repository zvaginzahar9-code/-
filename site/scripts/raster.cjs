// node raster.js <catalogDir> <height>  — renders every *-t.svg to <slug>-t.webp (transparent, fixed height)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
(async () => {
  const [dir, hArg] = process.argv.slice(2);
  const H = +hArg || 520;
  const b = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
  const p = await (await b.newContext({ deviceScaleFactor: 1 })).newPage();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-t.svg'));
  for (const f of files) {
    const svg = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = svg.match(/viewBox="([\d.\s-]+)"/)[1].trim().split(/\s+/).map(Number);
    const w = Math.ceil((m[2] / m[3]) * H);
    await p.setViewportSize({ width: w, height: H });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="display:block;width:${w}px;height:${H}px" `)}</body></html>`);
    const buf = await p.screenshot({ omitBackground: true, type: 'png' });
    fs.writeFileSync(path.join(dir, f.replace('.svg', '.png')), buf);
  }
  console.log('rendered', files.length);
  await b.close();
})();
