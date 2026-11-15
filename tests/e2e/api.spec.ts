import { expect, test } from '@playwright/test';
import { E2E } from '../../playwright.config';
import { newSessionPayload, SESSION_COOKIE, signSession } from '../../server/auth';

const origin = `http://localhost:${E2E.port}`;
const KEY = 'mal:999999001';
const url = `/api/annotations/${encodeURIComponent(KEY)}`;
const body = { refinedScore: 93, review: 'E2E test review', tags: ['rewatchable', ' made me cry '], favoriteCharacter: 'Test Character' };

async function sessionCookie(githubId: string): Promise<string> {
  const token = await signSession(newSessionPayload(githubId, 'e2e-admin'), E2E.sessionSecret);
  return `${SESSION_COOKIE}=${token}`;
}

test('annotations can be read by anyone', async ({ request }) => {
  const res = await request.get('/api/annotations');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  expect(typeof (await res.json()).annotations).toBe('object');
});

test('the write API rejects unauthenticated requests', async ({ request }) => {
  const res = await request.put(url, { data: body, headers: { Origin: origin } });
  expect(res.status()).toBe(401);
  const del = await request.delete(url, { headers: { Origin: origin } });
  expect(del.status()).toBe(401);
  expect((await (await request.get('/api/annotations')).json()).annotations[KEY]).toBeUndefined();
});

test('the write API rejects a forged or foreign session', async ({ request }) => {
  const forged = await request.put(url, { data: body, headers: { Origin: origin, Cookie: `${SESSION_COOKIE}=abc.def` } });
  expect(forged.status()).toBe(401);
  // A correctly signed session for a different GitHub account is still refused.
  const other = await request.put(url, { data: body, headers: { Origin: origin, Cookie: await sessionCookie('1') } });
  expect(other.status()).toBe(401);
});

test('the write API rejects cross-origin requests even with a valid session', async ({ request }) => {
  const cookie = await sessionCookie(E2E.adminGithubId);
  const res = await request.put(url, { data: body, headers: { Origin: 'https://evil.example', Cookie: cookie } });
  expect(res.status()).toBe(403);
});

test('a signed-in admin can save, and the public page shows the result', async ({ request, page }) => {
  const headers = { Origin: origin, Cookie: await sessionCookie(E2E.adminGithubId) };

  const bad = await request.put('/api/annotations/not%20a%20key', { data: body, headers });
  expect(bad.status()).toBe(400);

  const saved = await request.put(url, { data: body, headers });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).annotation).toMatchObject({
    refinedScore: 93,
    review: 'E2E test review',
    tags: ['rewatchable', 'made me cry'],
    favoriteCharacter: 'Test Character',
  });
  expect((await (await request.get('/api/annotations')).json()).annotations[KEY].refinedScore).toBe(93);

  // Out-of-range scores are dropped rather than stored.
  const clamped = await request.put(url, { data: { ...body, refinedScore: 500 }, headers });
  expect((await clamped.json()).annotation.refinedScore).toBeNull();

  const removed = await request.delete(url, { headers });
  expect(removed.status()).toBe(200);
  expect((await (await request.get('/api/annotations')).json()).annotations[KEY]).toBeUndefined();

  // Annotate a real list entry and check that the page picks it up without a rebuild.
  const data = await (await request.get('/data.json')).json();
  const target = data.items.find((i: { status: string; score: number | null }) => i.status === 'Dropped' && i.score !== null);
  const targetUrl = `/api/annotations/${encodeURIComponent(target.key)}`;
  try {
    await request.put(targetUrl, {
      data: { refinedScore: 97, tags: ['e2e-tag'], review: 'Shown inline.', favoriteCharacter: 'E2E Hero' },
      headers,
    });
    await page.goto('/?status=dropped');
    const row = page.locator(`#anime-list .item[data-key="${target.key}"]`);
    await expect(row.locator('.tier__num')).toHaveText('97');
    await expect(row.locator('.tier__name')).toHaveText('S+');
    // S+ gets its special look.
    await expect(row).toHaveClass(/item--top/);
    await expect(row.locator('.tier')).toHaveClass(/tier--top/);

    // A highlighted title below S+ gets the quieter look, with no extra text.
    await request.put(targetUrl, {
      data: { refinedScore: 72, highlight: true, tags: ['e2e-tag'], review: 'Shown inline.', favoriteCharacter: 'E2E Hero' },
      headers,
    });
    await page.reload();
    await expect(row).toHaveClass(/item--highlight/);
    await expect(row).not.toHaveClass(/item--top/);
    await expect(row.locator('.tier')).toHaveClass(/tier--highlight/);
    await expect(row.locator('.tier')).toHaveText(/^B\s*72\s*Good$/);
    await page.locator('#filter-tier').selectOption('highlighted');
    await expect(page.locator('#anime-list .item')).toHaveCount(1);
    await expect(row.locator('.chips li')).toHaveText('e2e-tag');
    // The favorite character needs no click; the review does.
    await expect(row.locator('.fav__name')).toBeVisible();
    await expect(row.locator('.fav__name')).toHaveText('E2E Hero');
    await expect(row.locator('.note__body')).toBeHidden();
    await row.locator('.note summary').click();
    await expect(row.locator('.note__body')).toContainText('Shown inline.');
  } finally {
    await request.delete(targetUrl, { headers });
  }
});

test('/admin is gated on the server', async ({ request }) => {
  const anonymous = await request.get('/admin', { maxRedirects: 0 });
  expect(anonymous.status()).toBe(302);
  expect(anonymous.headers().location).toContain('/api/auth/login');

  const login = await request.get('/api/auth/login', { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  expect(login.headers().location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);

  // Pages may first redirect /admin to its canonical URL; follow that by hand so the cookie is kept.
  const cookie = await sessionCookie(E2E.adminGithubId);
  let admin = await request.get('/admin', { headers: { Cookie: cookie }, maxRedirects: 0 });
  if (admin.status() >= 300 && admin.status() < 400) {
    const location = admin.headers().location ?? '';
    expect(location.replace(/\/$/, '').endsWith('/admin')).toBe(true);
    admin = await request.get(location, { headers: { Cookie: cookie }, maxRedirects: 0 });
  }
  expect(admin.status()).toBe(200);
  expect(admin.headers()['cache-control']).toContain('no-store');
  expect(await admin.text()).toContain('Notes and scores');

  const me = await (await request.get('/api/auth/me')).json();
  expect(me).toMatchObject({ authenticated: false, mode: 'github' });
});

test('a manual position decides the Top 10 order between titles with the same score', async ({ request, page }) => {
  const headers = { Origin: origin, Cookie: await sessionCookie(E2E.adminGithubId) };
  await page.goto('/');
  const topTitles = page.locator('#top-list .top-item__title');
  await expect(topTitles).toHaveCount(10);
  const [first, second] = await topTitles.allInnerTexts();
  const data = await (await request.get('/data.json')).json();
  const find = (title: string) => data.items.find((i: { title: string }) => i.title === title);
  const a = find(first!);
  const b = find(second!);
  test.skip(a.score !== b.score, 'the two best titles do not share a score in this dataset');
  const urlOf = (key: string) => `/api/annotations/${encodeURIComponent(key)}`;
  try {
    expect((await request.put(urlOf(b.key), { data: { topOrder: 1 }, headers })).status()).toBe(200);
    expect((await request.put(urlOf(a.key), { data: { topOrder: 2 }, headers })).status()).toBe(200);
    await page.reload();
    await expect(topTitles.nth(0)).toHaveText(second!);
    await expect(topTitles.nth(1)).toHaveText(first!);
  } finally {
    await request.delete(urlOf(a.key), { headers });
    await request.delete(urlOf(b.key), { headers });
  }
});

test('the admin panel edits notes and reorders the Top 10', async ({ browser, request }) => {
  const cookie = await sessionCookie(E2E.adminGithubId);
  // The session cookie is Secure and __Host- prefixed; sending it as a header works on plain-http localhost.
  const context = await browser.newContext({ extraHTTPHeaders: { Cookie: cookie }, viewport: { width: 1280, height: 900 } });
  // The panel asks AniList for the cast from the browser. Answer for it here, so the test needs no outside network.
  const kanade = 'https://s4.anilist.co/file/anilistcdn/character/medium/e2e-kanade.png';
  await context.route('https://graphql.anilist.co/**', (route) =>
    route.fulfill({
      json: {
        data: {
          Media: {
            characters: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { name: { full: 'Yuzuru Otonashi', native: null, alternative: [] }, image: { medium: null } },
                { name: { full: 'Kanade Tachibana', native: null, alternative: ['Tenshi'] }, image: { medium: kanade } },
              ],
            },
          },
        },
      },
    }),
  );
  const page = await context.newPage();
  const stored = async () =>
    Object.values((await (await request.get('/api/annotations')).json()).annotations) as {
      review: string | null;
      topOrder: number | null;
      favoriteCharacter: string | null;
      favoriteCharacterImage: string | null;
    }[];
  await page.goto('/admin/');
  await expect(page.locator('#adm-user')).toHaveText('Signed in as e2e-admin');

  // Notes and scores
  await page.locator('#adm-search').fill('angel beats');
  const row = page.locator('.adm-row:visible');
  await expect(row).toHaveCount(1);
  await row.locator('.adm-row__head').click();
  const save = row.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();

  await row.locator('[name="refinedScore"]').fill('88');
  await expect(row.locator('[data-preview] .tier__num')).toHaveText('88'); // live preview before saving
  await expect(row.locator('.adm-status')).toHaveText('Unsaved changes');
  await row.locator('[name="tags"]').fill('made me cry');
  await row.locator('[name="tags"]').press('Enter');
  await row.locator('[name="tags"]').fill('rewatchable');
  await row.locator('[name="tags"]').press('Enter');
  await expect(row.locator('[data-tags] li')).toHaveCount(2);
  // The cast is offered to pick from; a typed first name finds the same character and its picture.
  await expect(row.locator('[data-cast] .adm-pill')).toHaveCount(2);
  await row.locator('[name="favoriteCharacter"]').fill('Kanade');
  await expect(row.locator('[data-avatar]')).toBeVisible();
  await row.locator('[data-cast] .adm-pill', { hasText: 'Kanade Tachibana' }).click();
  await expect(row.locator('[name="favoriteCharacter"]')).toHaveValue('Kanade Tachibana');
  await row.locator('[name="review"]').fill('Admin e2e review.');
  // Highlighting is a single checkbox; the preview badge shows the look straight away.
  await row.locator('[data-highlight]').check();
  await expect(row.locator('[data-preview] .tier')).toHaveClass(/tier--highlight/);
  await save.click();
  await expect(row.locator('.adm-status')).toHaveText('Saved.');
  await expect(row.locator('.adm-row__marks')).toContainText('★ highlighted');
  expect((await stored()).find((a) => a.favoriteCharacter === 'Kanade Tachibana')?.favoriteCharacterImage).toBe(kanade);
  await expect(save).toBeDisabled();
  await expect(row.locator('.adm-row__marks .tier__num')).toHaveText('88');
  await expect(row.locator('.adm-row__marks')).toContainText('own score');
  await expect(row.locator('.adm-row__marks')).toContainText('2 tags');
  await expect(row.locator('.adm-row__marks')).toContainText('review');
  await page.screenshot({ path: 'test-results/admin.png' });
  expect((await stored()).some((a) => a.review === 'Admin e2e review.')).toBe(true);

  // An out-of-range score is refused by the script too, not only by the input's own max attribute.
  await row.locator('[name="refinedScore"]').evaluate((el: HTMLInputElement) => el.removeAttribute('max'));
  await row.locator('[name="refinedScore"]').fill('140');
  await expect(row.locator('.adm-status')).toContainText('must be a whole number');
  await row.getByRole('button', { name: 'Discard changes' }).click();
  await expect(row.locator('[name="refinedScore"]')).toHaveValue('88');

  // Removing everything takes two clicks.
  await row.locator('[data-clear]').click();
  await expect(row.locator('[data-clear]')).toHaveText('Click again to remove');
  await row.locator('[data-clear]').click();
  await expect(row.locator('.adm-status')).toHaveText('Removed.');
  expect((await stored()).some((a) => a.review === 'Admin e2e review.')).toBe(false);

  // Top 10 order
  await page.locator('.adm-tabs [data-panel="top"]').click();
  const topRows = page.locator('#top-groups .top-row');
  expect(await topRows.count()).toBeGreaterThanOrEqual(10);
  const titleAt = (n: number) => topRows.nth(n).locator('.top-row__title').innerText();
  const [one, two] = [await titleAt(0), await titleAt(1)];
  await expect(page.locator('#top-save')).toBeDisabled();
  await topRows.nth(0).getByRole('button', { name: /down$/ }).click();
  expect(await titleAt(0)).toBe(two);
  expect(await titleAt(1)).toBe(one);
  await page.screenshot({ path: 'test-results/admin-top.png' });
  await page.locator('#top-save').click();
  await expect(page.locator('#top-status')).toHaveText('Order saved.');
  expect((await stored()).filter((a) => a.topOrder !== null).length).toBeGreaterThan(1);

  // The public page follows the saved order.
  const publicPage = await context.newPage();
  await publicPage.goto('/');
  await expect(publicPage.locator('#top-list .top-item__title').first()).toHaveText(two);
  await publicPage.close();

  await page.locator('#top-reset').click();
  await expect(page.locator('#top-status')).toHaveText('Back to automatic order.');
  expect((await stored()).filter((a) => a.topOrder !== null)).toHaveLength(0);
  expect(await titleAt(0)).toBe(one);
  await context.close();
});
