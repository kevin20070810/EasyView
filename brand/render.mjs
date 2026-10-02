// 暖龄 EasyView · 品牌资产渲染脚本（需要本机有 Edge 或 Chromium）
// 用法: node brand/render.mjs            渲染全部
//       node brand/render.mjs poster     只渲染名字里含 poster 的图
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
async function loadPlaywright() {
  try { return await import('playwright'); }
  catch {
    const p = process.env.PLAYWRIGHT_PATH
      || 'C:/Users/ASUS/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright';
    return require(p);
  }
}
const { chromium } = await loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'src');
const out = path.join(here, 'out');
const only = process.argv[2];

const jobs = [
  // ---- 正式 PNG 导出（brand/logo/png/）----
  ['export.html', '[data-shot="mark-512"]',        '../logo/png/mark-512.png',        2, true],
  ['export.html', '[data-shot="mark-128"]',        '../logo/png/mark-128.png',        2, true],
  ['export.html', '[data-shot="mark-48"]',         '../logo/png/mark-48.png',         2, true],
  ['export.html', '[data-shot="mark-32"]',         '../logo/png/mark-32.png',         2, true],
  ['export.html', '[data-shot="mark-16"]',         '../logo/png/mark-16.png',         2, true],
  ['export.html', '[data-shot="mark-32-simple"]',      '../logo/png/mark-32-simple.png',  2, true],
  ['export.html', '[data-shot="mark-light-128"]',  '../logo/png/mark-light-128.png',  2, true],
  ['export.html', '[data-shot="seal-128"]',          '../logo/png/seal-128.png',        2, true],
  ['export.html', '[data-shot="lockup-horizontal"]','../logo/png/lockup-horizontal.png', 2, true],
  ['export.html', '[data-shot="lockup-stacked"]',  '../logo/png/lockup-stacked.png',  2, true],
  ['marks.html',  '[data-shot="secA"]', 'logo-scale-test.png',  2],
  ['marks.html',  '[data-shot="secB"]', 'logo-light-test.png',  2],
  ['marks.html',  '[data-shot="secC"]', 'logo-tiny-test.png',   2],
  ['marks.html',  '[data-shot="secD"]', 'logo-colour-test.png', 2],
  ['logo-v2.html', '[data-shot="v2A"]', 'logo-v2-A.png', 2],
  ['logo-v2.html', '[data-shot="v2B"]', 'logo-v2-B.png', 2],
  ['logo-v2.html', '[data-shot="v2C"]', 'logo-v2-C.png', 2],
  ['poster.html', '[data-shot="poster"]', 'poster-v1.png', 1],
  ['poster-v2.html', '[data-shot="poster2"]', 'poster-v2.png', 1],
  ['poster-v3.html', '[data-shot="poster3"]', 'poster-v3.png', 1],
  ['slide-v3.html', '[data-shot="slide3"]', 'slide-v3.png', 1],
  ['slide.html',  '[data-shot="slide"]',  'slide-v1.png',  1],
  ['slide-v2.html','[data-shot="slide2"]', 'slide-v2.png',  1],
  ['names.html',  '[data-shot="names"]',  'name-options.png', 2],
];

const files = new Set((await readdir(src)).filter(f => f.endsWith('.html')));
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });

for (const [file, sel, name, scale, transparent] of jobs) {
  if (!files.has(file)) continue;
  if (only && !name.includes(only) && !file.includes(only)) continue;
  const page = await browser.newPage(transparent
    ? { deviceScaleFactor: scale, viewport: { width: 1600, height: 2400 } }
    : { deviceScaleFactor: scale });
  await page.goto('file:///' + path.join(src, file).split(path.sep).join('/'));
  await page.waitForTimeout(400);
  const el = await page.$(sel);
  if (!el) { console.log('skip: ' + sel + ' not in ' + file); await page.close(); continue; }
  if (transparent) {
    const box = await el.boundingBox();
    await page.screenshot({ path: path.resolve(out, name), clip: box, omitBackground: true });
  } else {
    await el.screenshot({ path: path.resolve(out, name) });
  }
  console.log('ok ' + name);
  await page.close();
}
await browser.close();
