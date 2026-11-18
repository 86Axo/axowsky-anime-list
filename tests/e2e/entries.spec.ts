import { expect, test } from '@playwright/test';
import { E2E } from '../../playwright.config';
import { newSessionPayload, SESSION_COOKIE, signSession } from '../../server/auth';

const origin = `http://localhost:${E2E.port}`;

async function adminHeaders(): Promise<Record<string, string>> {
  const token = await signSession(newSessionPayload(E2E.adminGithubId, 'e2e-admin'), E2E.sessionSecret);
  return { Origin: origin, Cookie: `${SESSION_COOKIE}=${token}` };
}

// A title that is not on the OglądajAnime list used by the tests (checked against data/anime.json).
const FMAB = {
  malId: 5114,
  title: 'Fullmetal Alchemist: Brotherhood',
  titleEn: null,
  image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587.jpg',
  type: 'TV',
  status: 'Watching',
  watched: 10,
  total: 64,
  added: '2026-11-18T17:30:00',
  genres: ['Action', 'Adventure', 'Drama', 'Fantasy'],
  year: 2009,
  studio: 'Bones',
  duration: 24,
};

test.describe.configure({ mode: 'serial' });

test('hand-added titles: anyone can read them, only the admin can change them', async ({ request }) => {
  const read = await request.get('/api/entries');
  expect(read.status()).toBe(200);
  expect(Array.isArray((await read.json()).entries)).toBe(true);

  expect((await request.put('/api/entries/5114', { data: FMAB, headers: { Origin: origin } })).status()).toBe(401);
  expect((await request.delete('/api/entries/5114', { headers: { Origin: origin } })).status()).toBe(401);
  const foreign = { Origin: 'https://evil.example', Cookie: (await adminHeaders()).Cookie! };
  expect((await request.put('/api/entries/5114', { data: FMAB, headers: foreign })).status()).toBe(403);

  const headers = await adminHeaders();
  expect((await request.put('/api/entries/not-a-number', { data: FMAB, headers })).status()).toBe(400);
  expect((await request.put('/api/entries/5114', { data: { ...FMAB, title: '' }, headers })).status()).toBe(400);
});

test('a hand-added title shows on the public page with my score, and goes away when removed', async ({ request, page }) => {
  const headers = await adminHeaders();
  try {
    const saved = await request.put('/api/entries/5114', { data: { ...FMAB, image: 'https://evil.example/x.jpg' }, headers });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).entry).toMatchObject({ malId: 5114, title: 'Fullmetal Alchemist: Brotherhood', image: null });
    await request.put('/api/entries/5114', { data: FMAB, headers });
    await request.put('/api/annotations/mal%3A5114', { data: { refinedScore: 83 }, headers });

    await page.goto('/?q=brotherhood');
    const row = page.locator('#anime-list .item[data-key="mal:5114"]');
    await expect(row).toBeVisible();
    await expect(row.locator('.item__title')).toHaveText('Fullmetal Alchemist: Brotherhood');
    await expect(row.locator('.tier__num')).toHaveText('83');
    await expect(row.locator('.mal-link')).toHaveAttribute('href', 'https://myanimelist.net/anime/5114');
    // Counts rendered at build time follow the new title too.
    const all = Number(await page.locator('#status-tabs .tab[data-status="all"] .tab__count').innerText());
    expect(await page.locator('#list-total').innerText()).toBe(`${all} titles`);

    expect((await request.delete('/api/entries/5114', { headers })).status()).toBe(200);
    await page.reload();
    await expect(page.locator('#anime-list .item[data-key="mal:5114"]')).toHaveCount(0);
    // My notes on it are kept.
    expect((await (await request.get('/api/annotations')).json()).annotations['mal:5114'].refinedScore).toBe(83);
  } finally {
    await request.delete('/api/entries/5114', { headers });
    await request.delete('/api/annotations/mal%3A5114', { headers });
  }
});

test('a hand-added copy of a title already on my list is not shown twice', async ({ request, page }) => {
  const headers = await adminHeaders();
  try {
    await request.put('/api/entries/52991', { data: { malId: 52991, title: 'Frieren (by hand)', type: 'TV', status: 'Watching' }, headers });
    await page.goto('/?q=frieren');
    await expect(page.locator('#anime-list .item[data-key="mal:52991"]')).toHaveCount(1);
    await expect(page.locator('#anime-list .item__title', { hasText: '(by hand)' })).toHaveCount(0);
  } finally {
    await request.delete('/api/entries/52991', { headers });
  }
});

test('notes stored for one title are never overwritten through another title', async ({ request }) => {
  const headers = await adminHeaders();
  const key = '/api/annotations/mal%3A999999002';
  try {
    expect((await request.put(key, { data: { refinedScore: 88, aliases: ['oa:e2e-title-a'] }, headers })).status()).toBe(200);
    // Same MAL key, but saved on behalf of a different OglądajAnime title: refused.
    const clash = await request.put(key, { data: { refinedScore: 10, aliases: ['oa:e2e-title-b'] }, headers });
    expect(clash.status()).toBe(409);
    // Saving the same title again works, and the alias is kept even when a client leaves it out.
    expect((await request.put(key, { data: { refinedScore: 90 }, headers })).status()).toBe(200);
    const stored = (await (await request.get('/api/annotations')).json()).annotations['mal:999999002'];
    expect(stored).toMatchObject({ refinedScore: 90, aliases: ['oa:e2e-title-a'] });
  } finally {
    await request.delete(key, { headers });
  }
});

test('the admin panel adds a title found by search, then edits and removes it', async ({ browser, request }) => {
  const headers = await adminHeaders();
  const context = await browser.newContext({ extraHTTPHeaders: { Cookie: headers.Cookie! }, viewport: { width: 1280, height: 900 } });
  // The search runs in the browser against AniList. Answer for it here, so the test needs no outside network.
  await context.route('https://graphql.anilist.co/**', (route) =>
    route.fulfill({
      json: {
        data: {
          Page: {
            media: [
              {
                idMal: 5114,
                format: 'TV',
                episodes: 64,
                duration: 24,
                status: 'FINISHED',
                seasonYear: 2009,
                startDate: { year: 2009 },
                title: { romaji: 'Fullmetal Alchemist: Brotherhood', english: null },
                coverImage: { large: FMAB.image },
                genres: ['Action', 'Adventure', 'Drama', 'Fantasy'],
                studios: { nodes: [{ name: 'Bones' }] },
              },
              {
                // Already on the OglądajAnime list used by the tests: offered, but cannot be added twice.
                idMal: 52991,
                format: 'TV',
                episodes: 28,
                duration: 24,
                status: 'FINISHED',
                seasonYear: 2023,
                startDate: { year: 2023 },
                title: { romaji: 'Sousou no Frieren', english: null },
                coverImage: null,
                genres: [],
                studios: null,
              },
              { idMal: null, format: 'TV', episodes: 1, duration: 24, status: 'FINISHED', seasonYear: 2023, startDate: null, title: { romaji: 'No MAL id', english: null }, coverImage: null, genres: [], studios: null },
            ],
          },
        },
      },
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto('/admin/');
    await page.locator('.adm-tabs [data-panel="add"]').click();
    await expect(page.locator('#add-none')).toBeVisible();

    await page.locator('#add-search').fill('brotherhood');
    const results = page.locator('#add-results .add-result');
    await expect(results).toHaveCount(2); // the entry without a MAL id is left out
    const onList = results.filter({ hasText: 'Sousou no Frieren' });
    await expect(onList).toBeDisabled();
    await expect(onList).toContainText('Already on your OglądajAnime list');
    const result = results.filter({ hasText: 'Fullmetal Alchemist: Brotherhood' });
    await result.click();

    await expect(page.locator('#add-form')).toBeVisible();
    await expect(page.locator('#add-status')).toHaveValue('Completed');
    await expect(page.locator('#add-watched')).toHaveValue('64');
    await page.locator('#add-status').selectOption('Watching');
    await page.locator('#add-watched').fill('99');
    await expect(page.locator('#add-submit')).toBeDisabled();
    await expect(page.locator('#add-status-line')).toContainText('between 0 and 64');
    await page.locator('#add-watched').fill('10');
    await page.locator('#add-score').fill('83');
    await expect(page.locator('#add-score-preview .tier__num')).toHaveText('83');
    await page.screenshot({ path: 'test-results/admin-add.png' });
    await page.locator('#add-submit').click();

    await expect(page.locator('#add-search-status')).toHaveText('Added “Fullmetal Alchemist: Brotherhood” to your list.');
    await expect(page.locator('#add-form')).toBeHidden();
    await expect(result).toBeDisabled();
    await expect(result).toContainText('Already added by hand');
    const row = page.locator('#add-list .add-row');
    await expect(row).toHaveCount(1);
    await page.screenshot({ path: 'test-results/admin-add-list.png' });

    const stored = (await (await request.get('/api/entries')).json()).entries;
    expect(stored).toEqual([expect.objectContaining({ malId: 5114, status: 'Watching', watched: 10, total: 64 })]);
    expect((await (await request.get('/api/annotations')).json()).annotations['mal:5114'].refinedScore).toBe(83);

    // It is also in the Notes tab, marked as added by hand.
    await page.locator('.adm-tabs [data-panel="notes"]').click();
    await page.locator('#adm-search').fill('brotherhood');
    await expect(page.locator('.adm-row:visible .adm-row__meta')).toContainText('added by hand');
    await expect(page.locator('.adm-row:visible .adm-row__marks .tier__num')).toHaveText('83');

    // Edit progress, then remove (two clicks).
    await page.locator('.adm-tabs [data-panel="add"]').click();
    await row.locator('input[type="number"]').fill('12');
    await row.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#add-search-status')).toHaveText('Saved “Fullmetal Alchemist: Brotherhood”.');
    expect((await (await request.get('/api/entries')).json()).entries[0].watched).toBe(12);

    await page.locator('#add-list .add-row').getByRole('button', { name: 'Remove' }).click();
    await page.locator('#add-list .add-row').getByRole('button', { name: 'Click again to remove' }).click();
    await expect(page.locator('#add-search-status')).toContainText('Removed “Fullmetal Alchemist: Brotherhood”');
    await expect(page.locator('#add-list .add-row')).toHaveCount(0);
    expect((await (await request.get('/api/entries')).json()).entries).toEqual([]);
  } finally {
    await request.delete('/api/entries/5114', { headers });
    await request.delete('/api/annotations/mal%3A5114', { headers });
    await context.close();
  }
});
