import { describe, expect, it } from 'vitest';
import { newSessionPayload, readCookie, signSession, verifySession } from '../../server/auth';
import {
  annotationsFingerprint,
  isEmptyAnnotation,
  isValidKey,
  sanitizeAnnotation,
  sanitizeAnnotationMap,
} from '../../src/lib/annotations';
import { activityByMonth, annotate, computeStats, inProgress, tierCounts, topRated, type ListItem } from '../../src/lib/model';
import { applyState, DEFAULT_STATE, parseState, stateToQuery } from '../../src/lib/query';
import { esc, niceMax, renderItem, tierBadge } from '../../src/lib/render';

const item = (title: string, extra: Partial<ListItem> = {}): ListItem => ({
  key: `oa:${title.toLowerCase()}`,
  altKey: null,
  title,
  titleEn: null,
  malId: null,
  image: null,
  status: 'Completed',
  score: 7,
  watched: 12,
  total: 12,
  type: 'TV',
  added: '2024-03-01T10:00:00',
  genres: [],
  year: 2020,
  malScore: 7.5,
  studio: null,
  duration: 24,
  ...extra,
});

describe('sanitizeAnnotation', () => {
  it('keeps valid fields and trims text', () => {
    expect(sanitizeAnnotation({ refinedScore: 92, review: '  great  ', tags: [' a ', 'b', 'a', ''], favoriteCharacter: ' Yona ' })).toEqual({
      refinedScore: 92,
      review: 'great',
      tags: ['a', 'b'],
      favoriteCharacter: 'Yona',
    });
  });

  it('drops out-of-range scores and wrong types', () => {
    expect(sanitizeAnnotation({ refinedScore: 0 }).refinedScore).toBeNull();
    expect(sanitizeAnnotation({ refinedScore: 101 }).refinedScore).toBeNull();
    expect(sanitizeAnnotation({ refinedScore: '90' }).refinedScore).toBeNull();
    expect(sanitizeAnnotation({ tags: 'nope', review: 5 })).toMatchObject({ tags: [], review: null });
    expect(isEmptyAnnotation(sanitizeAnnotation(null))).toBe(true);
  });

  it('limits lengths', () => {
    const a = sanitizeAnnotation({ review: 'x'.repeat(5000), tags: Array.from({ length: 40 }, (_, i) => `tag${i}`) });
    expect(a.review).toHaveLength(2000);
    expect(a.tags).toHaveLength(12);
  });
});

describe('annotation keys and maps', () => {
  it('accepts mal:, oa: and title: keys only', () => {
    expect(isValidKey('mal:123')).toBe(true);
    expect(isValidKey('oa:86-eighty-six')).toBe(true);
    expect(isValidKey('title:some-title')).toBe(true);
    expect(isValidKey('mal:abc')).toBe(false);
    expect(isValidKey('oa:has space')).toBe(false);
    expect(isValidKey('../etc')).toBe(false);
  });

  it('drops invalid keys and empty annotations from a map', () => {
    const map = sanitizeAnnotationMap({ 'mal:1': { refinedScore: 80 }, 'mal:2': {}, bad: { refinedScore: 80 } });
    expect(Object.keys(map)).toEqual(['mal:1']);
  });

  it('fingerprints content, not key order or timestamps', () => {
    const a = sanitizeAnnotationMap({ 'mal:1': { refinedScore: 80, updatedAt: 'x' }, 'mal:2': { tags: ['t'] } });
    const b = sanitizeAnnotationMap({ 'mal:2': { tags: ['t'] }, 'mal:1': { refinedScore: 80, updatedAt: 'y' } });
    expect(annotationsFingerprint(a)).toBe(annotationsFingerprint(b));
    expect(annotationsFingerprint(a)).not.toBe(annotationsFingerprint(sanitizeAnnotationMap({ 'mal:1': { refinedScore: 81 } })));
  });
});

describe('sessions', () => {
  const secret = 'unit-test-secret';

  it('round-trips a signed session', async () => {
    const token = await signSession(newSessionPayload(42, 'someone'), secret);
    expect(await verifySession(token, secret)).toMatchObject({ sub: '42', login: 'someone' });
  });

  it('rejects a tampered payload, a wrong secret, garbage and expiry', async () => {
    const token = await signSession(newSessionPayload(42, 'someone'), secret);
    const [body, sig] = token.split('.');
    const forgedBody = btoa(JSON.stringify({ sub: '1', login: 'admin', exp: 9999999999 })).replace(/=+$/, '');
    expect(await verifySession(`${forgedBody}.${sig}`, secret)).toBeNull();
    expect(await verifySession(token, 'another-secret')).toBeNull();
    expect(await verifySession('garbage', secret)).toBeNull();
    expect(await verifySession(`${body}.${sig}.extra`, secret)).toBeNull();
    expect(await verifySession(token, secret, Date.now() + 8 * 24 * 3600 * 1000)).toBeNull();
  });

  it('reads one cookie out of the header', () => {
    const req = new Request('https://x.test', { headers: { Cookie: 'a=1; __Host-axo_session=tok.en; b=2' } });
    expect(readCookie(req, '__Host-axo_session')).toBe('tok.en');
    expect(readCookie(req, 'missing')).toBeNull();
  });
});

describe('model', () => {
  const items = [
    item('A', { score: 10, added: '2024-01-16T19:48:52' }),
    item('B', { score: 10, added: '2025-05-01T10:00:00' }),
    item('C', { score: 9, status: 'Watching', watched: 3, total: 12 }),
    item('D', { score: 10, status: 'Plan to Watch', watched: 0, total: null }),
    item('E', { score: null, status: 'Watching', watched: 12, total: 12 }),
    item('F', { score: 4, key: 'mal:6', altKey: 'oa:f' }),
  ];

  it('applies refined scores by key and by the OA fallback key', () => {
    const view = annotate(items, { 'oa:a': { refinedScore: 96, review: null, tags: ['x'], favoriteCharacter: null }, 'oa:f': { refinedScore: 55, review: 'ok', tags: [], favoriteCharacter: null } });
    expect(view.find((i) => i.title === 'A')).toMatchObject({ final: 96, tierId: 'sp', tags: ['x'] });
    expect(view.find((i) => i.title === 'B')).toMatchObject({ final: 100, tierId: 'sp' });
    expect(view.find((i) => i.title === 'F')).toMatchObject({ final: 55, tierId: 'd', review: 'ok' });
    expect(view.find((i) => i.title === 'E')).toMatchObject({ final: null, tierId: null });
  });

  it('ranks the top list by score, then by most recently added, and skips plan-to-watch', () => {
    const top = topRated(annotate(items, {}));
    expect(top.map((i) => i.title)).toEqual(['B', 'A', 'C', 'F']);
  });

  it('computes stats without counting plan-to-watch scores', () => {
    const s = computeStats(annotate(items, {}));
    expect(s).toMatchObject({ total: 6, completed: 3, episodes: 12 + 12 + 3 + 0 + 12 + 12, rated: 4 });
    expect(s.meanScore).toBeCloseTo((100 + 100 + 90 + 40) / 4);
    expect(s.hours).toBe(Math.round((51 * 24) / 60));
  });

  it('lists only part-watched shows as in progress', () => {
    const { shown, totalWatching } = inProgress(annotate(items, {}));
    expect(shown.map((i) => i.title)).toEqual(['C']);
    expect(totalWatching).toBe(2);
  });

  it('counts tiers in order, including empty ones', () => {
    const counts = tierCounts(annotate(items, {}));
    expect(counts.map((c) => c.name)).toEqual(['S+', 'S', 'A', 'B', 'C', 'D', 'F']);
    expect(counts.map((c) => c.count)).toEqual([2, 1, 0, 0, 0, 0, 1]);
  });

  it('fills month gaps and reports a bulk import separately', () => {
    const many = [
      ...Array.from({ length: 60 }, (_, i) => item(`bulk${i}`, { added: `2024-01-16T19:${String(i % 60).padStart(2, '0')}:00` })),
      item('x', { added: '2024-01-20T10:00:00' }),
      item('y', { added: '2024-04-02T10:00:00' }),
    ];
    const a = activityByMonth(annotate(many, {}));
    expect(a.bulk).toEqual({ date: '2024-01-16', count: 60 });
    expect(a.months).toEqual([
      { month: '2024-01', count: 1 },
      { month: '2024-02', count: 0 },
      { month: '2024-03', count: 0 },
      { month: '2024-04', count: 1 },
    ]);
  });
});

describe('list state', () => {
  const view = annotate(
    [
      item('Alpha', { score: 9, genres: ['Action'], malScore: 8.1, added: '2024-01-01T00:00:00' }),
      item('Beta', { score: null, status: 'Watching', type: 'Movie', malScore: null, added: null }),
      item('Gamma', { score: 5, status: 'Dropped', genres: ['Drama'], titleEn: 'The Third', malScore: 6.2, added: '2025-01-01T00:00:00' }),
    ],
    {},
  );

  it('round-trips through the query string and omits defaults', () => {
    expect(stateToQuery(DEFAULT_STATE)).toBe('');
    const q = stateToQuery({ ...DEFAULT_STATE, status: 'on-hold', q: 'yona', sort: 'title', dir: 'desc', view: 'grid' });
    expect(q).toBe('?status=on-hold&q=yona&sort=title&dir=desc&view=grid');
    expect(parseState(new URLSearchParams(q))).toMatchObject({ status: 'on-hold', q: 'yona', sort: 'title', dir: 'desc', view: 'grid' });
  });

  it('ignores unknown values in the query string', () => {
    expect(parseState(new URLSearchParams('status=nope&sort=bogus&dir=sideways&view=cube'))).toEqual(DEFAULT_STATE);
    expect(parseState(new URLSearchParams('sort=title'))).toMatchObject({ sort: 'title', dir: 'asc' });
  });

  it('filters by status, genre, type, tier and search text', () => {
    const names = (s: Partial<typeof DEFAULT_STATE>) => applyState(view, { ...DEFAULT_STATE, ...s }).map((i) => i.title);
    expect(names({ status: 'dropped' })).toEqual(['Gamma']);
    expect(names({ genre: 'Action' })).toEqual(['Alpha']);
    expect(names({ type: 'Movie' })).toEqual(['Beta']);
    expect(names({ tier: 's' })).toEqual(['Alpha']);
    expect(names({ tier: 'none' })).toEqual(['Beta']);
    expect(names({ q: 'third' })).toEqual(['Gamma']);
    expect(names({ q: 'ALPHA' })).toEqual(['Alpha']);
    expect(names({ q: 'nothing' })).toEqual([]);
  });

  it('sorts, always keeping entries without a value last', () => {
    const names = (s: Partial<typeof DEFAULT_STATE>) => applyState(view, { ...DEFAULT_STATE, ...s }).map((i) => i.title);
    expect(names({ sort: 'score', dir: 'desc' })).toEqual(['Alpha', 'Gamma', 'Beta']);
    expect(names({ sort: 'score', dir: 'asc' })).toEqual(['Gamma', 'Alpha', 'Beta']);
    expect(names({ sort: 'title', dir: 'desc' })).toEqual(['Gamma', 'Beta', 'Alpha']);
    expect(names({ sort: 'added', dir: 'desc' })).toEqual(['Gamma', 'Alpha', 'Beta']);
    expect(names({ sort: 'mal', dir: 'desc' })).toEqual(['Alpha', 'Gamma', 'Beta']);
  });
});

describe('render', () => {
  it('escapes data in HTML', () => {
    expect(esc(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;');
    const html = renderItem(annotate([item('<b>Evil</b>')], { 'oa:<b>evil</b>': { refinedScore: null, review: '<script>x</script>', tags: ['<i>'], favoriteCharacter: null } })[0]!);
    expect(html).not.toContain('<b>Evil</b>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
  });

  it('renders the tier badge as tier, number and label', () => {
    const html = tierBadge(92);
    expect(html).toContain('data-tier="s"');
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).toBe('S 92 Exceptional');
    expect(tierBadge(null)).toContain('Not rated');
  });

  it('links matched titles to MAL and unmatched ones to a MAL search', () => {
    const [matched, unmatched] = annotate([item('X', { malId: 6547 }), item('Y & Z')], {});
    expect(renderItem(matched!)).toContain('href="https://myanimelist.net/anime/6547" target="_blank" rel="noopener"');
    expect(renderItem(unmatched!)).toContain('href="https://myanimelist.net/anime.php?q=Y%20%26%20Z&amp;cat=anime"');
  });

  it('rounds chart axes to clean numbers', () => {
    expect([3, 17, 40, 41, 169].map(niceMax)).toEqual([4, 20, 40, 50, 200]);
  });
});
