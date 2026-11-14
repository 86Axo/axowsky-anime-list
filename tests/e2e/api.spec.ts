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
    await request.put(targetUrl, { data: { refinedScore: 97, tags: ['e2e-tag'], review: 'Shown inline.' }, headers });
    await page.goto('/?status=dropped');
    const row = page.locator(`#anime-list .item[data-key="${target.key}"]`);
    await expect(row.locator('.tier__num')).toHaveText('97');
    await expect(row.locator('.tier__name')).toHaveText('S+');
    await expect(row.locator('.chips li')).toHaveText('e2e-tag');
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
  expect(await admin.text()).toContain('Annotations');

  const me = await (await request.get('/api/auth/me')).json();
  expect(me).toMatchObject({ authenticated: false, mode: 'github' });
});
