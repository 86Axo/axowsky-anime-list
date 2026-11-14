/**
 * Section-by-section screenshots for visual review (smaller than one full-page image).
 *   npx tsx scripts/review-shots.ts [baseUrl] [outDir] [desktop|mobile] [light|dark] [query]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [base = 'http://localhost:4321', out = 'test-results/review', device = 'desktop', scheme = 'light', query = ''] =
  process.argv.slice(2);
mkdirSync(out, { recursive: true });
const viewport = device === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 900 };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport, colorScheme: scheme as 'light' | 'dark', deviceScaleFactor: device === 'mobile' ? 2 : 1 });
const page = await ctx.newPage();
await page.goto(base + '/' + query, { waitUntil: 'networkidle' });

const sections: [string, string, number][] = [
  ['hero', 'header.topbar, .hero', 0],
  ['watching', '#watching', 0],
  ['top', '#top', 0],
  ['list', '#list', 1100],
  ['charts', '#charts', 0],
];
for (const [name, selector, maxHeight] of sections) {
  const els = page.locator(selector);
  await els.last().scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const boxes = await els.evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
    }),
  );
  const y = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  const height = maxHeight ? Math.min(bottom - y, maxHeight) : bottom - y;
  const file = join(out, `${name}-${device}-${scheme}.png`);
  await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: Math.max(0, y - 16), width: viewport.width, height: height + 32 } });
  console.log(file);
}
await browser.close();
