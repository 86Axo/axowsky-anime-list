import { describe, expect, it } from 'vitest';
import { searchAnime, toCandidate } from '../../src/lib/anilist-search';
import { sanitizeAnnotation } from '../../src/lib/annotations';
import { entriesFingerprint, entryToItem, mergeEntries, nowLocal, sanitizeEntries, sanitizeEntry, supersededEntries } from '../../src/lib/entries';
import { annotate, type ListItem } from '../../src/lib/model';

const base = {
  malId: 52991,
  title: 'Sousou no Frieren',
  titleEn: "Frieren: Beyond Journey's End",
  image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587.jpg',
  type: 'TV',
  status: 'Watching',
  watched: 10,
  total: 28,
  added: '2026-11-18T17:30:00',
  genres: ['Adventure', 'Drama', 'Fantasy'],
  year: 2023,
  studio: 'Madhouse',
  duration: 24,
};

const listRow = (malId: number | null, title: string): ListItem => ({
  key: malId ? `mal:${malId}` : `oa:${title}`,
  altKey: malId ? `oa:${title}` : null,
  title,
  titleEn: null,
  malId,
  image: null,
  status: 'Completed',
  score: 7,
  watched: 12,
  total: 12,
  type: 'TV',
  added: '2024-01-01T10:00:00',
  genres: [],
  year: null,
  malScore: null,
  studio: null,
  duration: 24,
});

describe('sanitizeEntry', () => {
  it('keeps a valid entry as it is', () => {
    expect(sanitizeEntry(base)).toEqual(base);
  });

  it('needs a MAL id and a title', () => {
    expect(sanitizeEntry({ ...base, malId: undefined })).toBeNull();
    expect(sanitizeEntry({ ...base, malId: -1 })).toBeNull();
    expect(sanitizeEntry({ ...base, title: '   ' })).toBeNull();
    expect(sanitizeEntry(null)).toBeNull();
  });

  it('falls back to safe values for everything else', () => {
    const e = sanitizeEntry({ malId: 1, title: 'X', type: 'Music', status: 'Binged', watched: 'lots', total: 0, added: 'yesterday', year: 3000 })!;
    expect(e).toMatchObject({ type: 'Unknown', status: 'Completed', watched: 0, total: null, year: null, image: null, genres: [] });
    expect(e.added).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });

  it('never lets progress exceed the episode count', () => {
    expect(sanitizeEntry({ ...base, watched: 99 })!.watched).toBe(28);
  });

  it('only accepts covers from the known image hosts', () => {
    expect(sanitizeEntry({ ...base, image: 'https://evil.example/x.jpg' })!.image).toBeNull();
    expect(sanitizeEntry({ ...base, image: 'javascript:alert(1)' })!.image).toBeNull();
  });

  it('trims and limits text', () => {
    const e = sanitizeEntry({ ...base, title: `  ${'x'.repeat(300)}  `, genres: Array.from({ length: 20 }, (_, i) => `g${i}`) })!;
    expect(e.title).toHaveLength(200);
    expect(e.genres).toHaveLength(12);
  });

  it('formats the local time like the OglądajAnime dates', () => {
    expect(nowLocal(new Date(2026, 0, 5, 7, 8, 9))).toBe('2026-01-05T07:08:09');
  });
});

describe('merging hand-added titles into the list', () => {
  const list = [listRow(1, 'a'), listRow(null, 'b')];

  it('adds them as list items keyed by MAL id, without an OglądajAnime score', () => {
    const item = entryToItem(sanitizeEntry(base)!);
    expect(item).toMatchObject({ key: 'mal:52991', altKey: null, malId: 52991, score: null, manual: true, status: 'Watching', watched: 10, total: 28 });
    const merged = mergeEntries(list, [sanitizeEntry(base)!]);
    expect(merged.map((i) => i.key)).toEqual(['mal:1', 'oa:b', 'mal:52991']);
  });

  it('hides a hand-added copy once the title is on my OglądajAnime list, and says so', () => {
    const dup = sanitizeEntry({ ...base, malId: 1, title: 'a (by hand)' })!;
    expect(mergeEntries(list, [dup]).map((i) => i.title)).toEqual(['a', 'b']);
    expect(supersededEntries(list, [dup, sanitizeEntry(base)!])).toEqual(new Set([1]));
  });

  it('gives a hand-added title its own score through my notes', () => {
    const [view] = annotate(mergeEntries([], [sanitizeEntry(base)!]), { 'mal:52991': sanitizeAnnotation({ refinedScore: 83 }) });
    expect(view!.final).toBe(83);
    expect(view!.tierId).toBe('a');
  });

  it('cleans a list from the API and notices changes', () => {
    const cleaned = sanitizeEntries([base, base, { title: 'no id' }, 'junk']);
    expect(cleaned).toHaveLength(1);
    expect(sanitizeEntries('nope')).toEqual([]);
    const fp = entriesFingerprint(cleaned);
    expect(entriesFingerprint([{ ...cleaned[0]!, watched: 11 }])).not.toBe(fp);
    expect(entriesFingerprint([...cleaned])).toBe(fp);
  });
});

describe('AniList search for the Add anime tab', () => {
  const media = {
    idMal: 52991,
    format: 'TV',
    episodes: 28,
    duration: 24,
    status: 'FINISHED',
    seasonYear: 2023,
    startDate: { year: 2023 },
    title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey's End" },
    coverImage: { large: base.image },
    genres: ['Adventure', 'Drama', 'Fantasy'],
    studios: { nodes: [{ name: 'Madhouse' }] },
  };

  it('turns an AniList result into an entry draft keyed by MAL id', () => {
    expect(toCandidate(media)).toEqual({
      malId: 52991,
      title: 'Sousou no Frieren',
      titleEn: "Frieren: Beyond Journey's End",
      image: base.image,
      type: 'TV',
      total: 28,
      genres: ['Adventure', 'Drama', 'Fantasy'],
      year: 2023,
      studio: 'Madhouse',
      duration: 24,
      airing: 'FINISHED',
    });
  });

  it('skips results without a MAL id, which could not be linked', () => {
    expect(toCandidate({ ...media, idMal: null })).toBeNull();
  });

  it('maps formats to list types', () => {
    expect(toCandidate({ ...media, format: 'TV_SHORT' })!.type).toBe('TV');
    expect(toCandidate({ ...media, format: 'MOVIE' })!.type).toBe('Movie');
    expect(toCandidate({ ...media, format: 'MUSIC' })!.type).toBe('Unknown');
  });

  it('searches once and explains failures', async () => {
    const calls: unknown[] = [];
    const ok = (async (_u: unknown, init?: { body?: unknown }) => {
      calls.push(JSON.parse(String(init?.body)).variables);
      return new Response(JSON.stringify({ data: { Page: { media: [media, { ...media, idMal: null }] } } }), { status: 200 });
    }) as typeof fetch;
    const found = await searchAnime('frieren', ok);
    expect(found.map((c) => c.malId)).toEqual([52991]);
    expect(calls).toEqual([{ q: 'frieren' }]);
    const slow = (async () => new Response('', { status: 429 })) as typeof fetch;
    await expect(searchAnime('frieren', slow)).rejects.toThrow(/slow down/);
  });
});
