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

  await expect(page).toHaveTitle("Axo86's Anime List");
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("Axo86's Anime List");
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

test('the header backdrop drifts in a seamless loop, and stands still when motion is reduced', async ({ page, isMobile }) => {
  test.skip(isMobile, 'narrow screens have no backdrop');
  await ready(page);
  const track = page.locator('#hero-covers .hero__track');
  await expect(page.locator('#hero-covers')).toBeVisible();
  expect(await track.evaluate((el) => getComputedStyle(el).animationName)).toBe('hero-drift');
  // It really moves, and to the right.
  const x = () => track.evaluate((el) => el.getBoundingClientRect().left);
  const before = await x();
  await page.waitForTimeout(700);
  expect(await x()).toBeGreaterThan(before);
  // Two identical halves: sliding by half the width shows the same covers again.
  const sources = await track.locator('img').evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).src));
  expect(sources.length % 2).toBe(0);
  expect(sources.slice(0, sources.length / 2)).toEqual(sources.slice(sources.length / 2));
  // The track is wider than twice the window, so no gap ever shows.
  const width = await track.evaluate((el) => el.getBoundingClientRect().width);
  expect(width / 2).toBeGreaterThan(page.viewportSize()!.width);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await track.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
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

test('every title has a MAL button that opens MyAnimeList in a new tab', async ({ page }) => {
  await ready(page);
  // One button per title, and the title itself is plain text.
  expect(await page.locator('#anime-list .item .mal-link').count()).toBe(await titles(page).count());
  expect(await page.locator('#anime-list .item__title a, #anime-list a.item__title').count()).toBe(0);
  const links = page.locator('#anime-list .mal-link, #top-list .mal-link, #watch-row .mal-link');
  const count = await links.count();
  expect(count).toBeGreaterThan(30);
  for (const link of await links.all()) {
    expect(await link.getAttribute('href')).toMatch(/^https:\/\/myanimelist\.net\/anime(\/\d+|\.php\?q=)/);
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toContain('noopener');
  }
});

test('the Charts link jumps straight to the charts without loading more of the list', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the section links are hidden on narrow screens');
  await ready(page);
  const before = await titles(page).count();
  await page.locator('.nav a[href="#charts"]').click();
  await expect(page.locator('#charts-title')).toBeInViewport();
  // Give a wrongly triggered load time to happen, then make sure it did not.
  await page.waitForTimeout(800);
  await expect(page.locator('#charts-title')).toBeInViewport();
  expect(await titles(page).count()).toBe(before);
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

test('a perfect 100 wears a crown and its own label', async ({ page }) => {
  await ready(page);
  const perfect = page.locator('#anime-list .item--perfect').first();
  await expect(perfect).toBeVisible();
  await expect(perfect.locator('.tier')).toHaveClass(/tier--perfect/);
  await expect(perfect.locator('.tier__crown')).toBeVisible();
  await expect(perfect.locator('.tier__label')).toHaveText('Perfect');
  await expect(perfect.locator('.tier__num')).toHaveText('100');
});
