/**
 * Mobile Lighthouse audit against a running build.
 *   npx tsx scripts/lighthouse.ts [url] [reportPath]
 * Starts Playwright's Chromium with a debugging port and points the Lighthouse CLI at it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:8788/';
const out = process.argv[3] ?? 'test-results/lighthouse.json';
const port = 9333;

const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
try {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', 'lighthouse', url, `--port=${port}`, '--quiet', '--output=json', `--output-path=${out}`],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  );
} finally {
  await browser.close();
}

const report = JSON.parse(readFileSync(out, 'utf8'));
for (const [id, cat] of Object.entries<{ score: number }>(report.categories)) {
  console.log(`${id.padEnd(16)} ${Math.round(cat.score * 100)}`);
}
for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index']) {
  console.log(`  ${id.padEnd(26)} ${report.audits[id].displayValue}`);
}
for (const [catId, cat] of Object.entries<{ auditRefs: { id: string; weight: number }[] }>(report.categories)) {
  for (const ref of cat.auditRefs) {
    const audit = report.audits[ref.id];
    if (audit.score !== null && audit.score < 0.9) console.log(`  ! ${catId}: ${ref.id} (${audit.score}) ${audit.displayValue ?? ''}`);
  }
}
