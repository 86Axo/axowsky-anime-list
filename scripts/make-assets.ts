/**
 * Renders the static image assets from the dawn motif:
 *   public/og.png (1200×630) and public/apple-touch-icon.png (180×180).
 * Run once after changing the motif or the site title:  npx tsx scripts/make-assets.ts
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { SITE } from '../src/config/site';

const font = readFileSync('node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2').toString('base64');
const arcs = (cx: number, y: number, count: number, first: number, step: number, color: string, fade = 0.7): string =>
  Array.from({ length: count }, (_, i) => {
    const r = first + i * step;
    const opacity = (1 - (i / count) * fade).toFixed(3);
    return `<path d="M${cx - r} ${y}A${r} ${r} 0 0 1 ${cx + r} ${y}" stroke="${color}" stroke-width="1.25" fill="none" opacity="${opacity}"/>`;
  }).join('');

const og = `<!doctype html><html><head><style>
@font-face{font-family:Inter;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#fbfaf8;color:#1d1b19;font-family:Inter,sans-serif;position:relative;overflow:hidden}
svg{position:absolute;right:88px;bottom:0}
.t{position:absolute;left:88px;top:196px}
.a{display:grid;place-items:center;width:84px;height:84px;border-radius:50%;background:#1d1b19;color:#fbfaf8;font-size:36px;font-weight:600;margin-bottom:36px}
h1{font-size:76px;font-weight:650;letter-spacing:-0.035em;line-height:1.05}
p{margin-top:20px;font-size:28px;color:#5b5752}
.r{position:absolute;left:0;right:0;bottom:0;height:1px;background:#d9d6d2}
</style></head><body>
<svg width="560" height="280" viewBox="0 0 560 280">
${arcs(280, 280, 5, 80, 44, '#8f8b85')}<path d="M238 280A42 42 0 0 1 322 280Z" fill="#b8233c"/></svg>
<div class="t"><div class="a">${SITE.nickname.slice(0, 1)}</div><h1>${SITE.title.replace(/'/g, '&#39;')}</h1><p>Ratings, tiers and stats for everything I have watched</p></div>
<div class="r"></div></body></html>`;

const icon = `<!doctype html><html><head><style>*{margin:0}body{width:180px;height:180px;background:#fbfaf8}</style></head><body>
<svg width="180" height="180" viewBox="0 0 32 32" fill="none" stroke="#b8233c" stroke-width="2" stroke-linecap="round">
<path d="M11.5 22a4.5 4.5 0 0 1 9 0z" fill="#b8233c" stroke="none"/><path d="M7.5 22a8.5 8.5 0 0 1 17 0"/>
<path d="M3.5 22a12.5 12.5 0 0 1 25 0M3.5 26h25" opacity=".55"/></svg></body></html>`;

const browser = await chromium.launch();
for (const [html, width, height, file] of [
  [og, 1200, 630, 'public/og.png'],
  [icon, 180, 180, 'public/apple-touch-icon.png'],
] as const) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file });
  console.log(file);
  await page.close();
}
await browser.close();
