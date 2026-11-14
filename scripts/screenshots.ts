/**
 * Full-page screenshots in both themes, desktop and mobile, for visual review.
 *   npx tsx scripts/screenshots.ts [baseUrl] [outDir] [path]
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:4321';
const out = process.argv[3] ?? 'test-results/screens';
const path = process.argv[4] ?? '/';
mkdirSync(out, { recursive: true });

const sizes = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const name = path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home';

const browser = await chromium.launch();
for (const size of sizes) {
  for (const scheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      colorScheme: scheme,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.goto(base + path, { waitUntil: 'networkidle' });
    // Scroll through the page so lazy images load before the capture.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);
    const file = join(out, `${name}-${size.name}-${scheme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
    await ctx.close();
  }
}
await browser.close();
