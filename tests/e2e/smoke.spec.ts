import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const titles = (page: Page) => page.locator('#anime-list .item__title');

/** Wait until the client script has loaded the data and taken over the list. */
async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#result-count')).toContainText(/titles/);
  await page.waitForFunction(() => document.querySelector('#theme-toggle')?.getAttribute('aria-label')?.startsWith('Switch to'));
  await page.waitForLoadState('networkidle');
}

test('loads the profile page with every section', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // Cover images come from MAL's CDN; a blocked or offline CDN must not fail the smoke test.
    if (m.type() === 'error' && !m.location().url.includes('myanimelist.net')) errors.push(m.text());
  });
  await ready(page);

  await expect(page).toHaveTitle("Axowsky's Anime List");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("Axowsky's Anime List");
  for (const name of ['Currently watching', 'Top 10', 'Full list', 'Charts']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  await expect(page.locator('#stats .stat')).toHaveCount(6);
  await expect(page.locator('#top-list .top-item')).toHaveCount(10);
  expect(await titles(page).count()).toBeGreaterThan(20);
  await expect(page.getByRole('heading', { name: 'Added to list per month' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('page does not scroll sideways', async ({ page }) => {
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('theme toggle switches themes and remembers the choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await ready(page);
  const html = page.locator('html');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await background();

  await page.locator('#theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  expect(await background()).not.toBe(light);

  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await page.locator('#theme-toggle').click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  expect(await background()).toBe(light);
});

test('follows the system theme when no choice was made', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await ready(page);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
  expect(scheme).toContain('dark');
  // Paint the background onto a canvas to read it as plain RGB, whatever color syntax the browser reports.
  const lightness = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 255, g = 255, b = 255] = ctx.getImageData(0, 0, 1, 1).data;
    return r + g + b;
  });
  expect(lightness).toBeLessThan(200);
});

test('status tabs, search and view toggle filter the list and update the URL', async ({ page }) => {
  await ready(page);

  // Status tab
  const completed = page.locator('#status-tabs .tab[data-status="completed"]');
  const expected = Number(await completed.locator('.tab__count').innerText());
  await completed.click();
  await expect(completed).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/[?&]status=completed/);
  await expect(page.locator('#result-count')).toHaveText(new RegExp(`^${expected} of \\d+ titles$`));
  for (const status of await page.locator('#anime-list .item__status').allInnerTexts()) expect(status.trim()).toBe('Completed');

  // Search, focused with "/"
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.type('code geass');
  await expect(page).toHaveURL(/[?&]q=code\+geass/);
  const found = await titles(page).allInnerTexts();
  expect(found.length).toBeGreaterThan(0);
  for (const t of found) expect(t.toLowerCase()).toContain('code geass');

  // Nothing found → empty state, then clear
  await page.locator('#search').fill('zzzz-no-such-anime');
  await expect(page.locator('#empty')).toBeVisible();
  await page.locator('#empty-clear').click();
  await expect(page.locator('#empty')).toBeHidden();
  await expect(page).toHaveURL(/\/$/);

  // View toggle
  await page.locator('.view-toggle [data-view="grid"]').click();
  await expect(page.locator('#anime-list')).toHaveAttribute('data-view', 'grid');
  await expect(page).toHaveURL(/[?&]view=grid/);
});

test('a shared URL restores filters and sorting', async ({ page }) => {
  await page.goto('/?status=dropped&sort=title&dir=desc');
  await expect(page.locator('#status-tabs .tab[data-status="dropped"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sort')).toHaveValue('title');
  await expect(page.locator('#result-count')).toContainText(' of ');
  const shown = await titles(page).allInnerTexts();
  expect(shown.length).toBeGreaterThan(0);
  const sorted = [...shown].sort((a, b) => b.localeCompare(a, 'en', { sensitivity: 'base' }));
  expect(shown).toEqual(sorted);
});

test('every title links to MyAnimeList in a new tab', async ({ page }) => {
  await ready(page);
  const links = page.locator('#anime-list .item__title, #top-list .top-item__title, #watch-row .watch-card__title');
  const count = await links.count();
  expect(count).toBeGreaterThan(30);
  for (const link of await links.all()) {
    expect(await link.getAttribute('href')).toMatch(/^https:\/\/myanimelist\.net\/anime(\/\d+|\.php\?q=)/);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
  }
});

test('more rows are rendered on demand', async ({ page }) => {
  await ready(page);
  const before = await titles(page).count();
  await page.locator('#show-more').scrollIntoViewIfNeeded();
  await expect.poll(() => titles(page).count()).toBeGreaterThan(before);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`has no accessibility violations (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await ready(page);
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.html.slice(0, 160)}`);
    expect(summary).toEqual([]);
  });
}
