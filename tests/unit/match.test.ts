import { describe, expect, it } from 'vitest';
import {
  AniListClient,
  AniListUnavailableError,
  aniListToMalInfo,
  buildSearchQuery,
  toCandidate,
  type AniListMedia,
} from '../../scripts/lib/anilist';
import { parseDuration, toMalInfo } from '../../scripts/lib/jikan';
import {
  baseTitle,
  cleanTitle,
  diceSimilarity,
  matchKey,
  normalizeTitle,
  pickBestMatch,
  searchQueries,
  sequelSignature,
  shortenQuery,
  typesAgree,
  type Candidate,
} from '../../scripts/lib/match';
import { buildEntries, mergeSources } from '../../scripts/lib/merge';
import type { MalInfo, OaEntry } from '../../src/lib/types';

const c = (mal_id: number, title: string, extra: Partial<Candidate> = {}): Candidate => ({
  mal_id,
  title,
  type: 'TV',
  ...extra,
});

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation and diacritics', () => {
    expect(normalizeTitle('86: Eighty Six')).toBe('86 eighty six');
    expect(normalizeTitle('Angel Beats!')).toBe('angel beats');
    expect(normalizeTitle('Pokémon  —  The Movie')).toBe('pokemon the movie');
    expect(normalizeTitle("Fate/Stay Night: Heaven's Feel")).toBe('fate stay night heavens feel');
  });
});

describe('sequelSignature', () => {
  it.each([
    ['Akatsuki no Yona', 1, 1],
    ['Akatsuki no Yona Season 2', 2, 1],
    ['Tensei shitara Slime Datta Ken 4th Season', 4, 1],
    ['Goblin Slayer 2nd Season', 2, 1],
    ['Mob Psycho 100 II', 2, 1],
    ['Overlord IV', 4, 1],
    ['Xian Wang de Richang Shenghuo 4', 4, 1],
    ['86: Eighty Six Part 2', 1, 2],
    ['Shingeki no Kyojin: The Final Season Part 2', 99, 2],
    ['Maou Gakuin no Futekigousha II (2 Cour)', 2, 2],
    ['Kaijuu 8-gou', 1, 1],
    ['Mob Psycho 100', 1, 1],
    ['91 Days', 1, 1],
  ])('%s → season %i, part %i', (title, season, part) => {
    expect(sequelSignature(title)).toEqual({ season, part });
  });
});

describe('diceSimilarity', () => {
  it('is 1 for identical strings and lower for different ones', () => {
    expect(diceSimilarity('angel beats', 'angel beats')).toBe(1);
    expect(diceSimilarity('angel beats', 'angel beast')).toBeGreaterThan(0.7);
    expect(diceSimilarity('angel beats', 'clannad')).toBeLessThan(0.2);
  });
});

describe('typesAgree', () => {
  it('treats TV Special as Special and unknown types as compatible', () => {
    expect(typesAgree('Special', 'TV Special')).toBe(true);
    expect(typesAgree('TV', 'Movie')).toBe(false);
    expect(typesAgree('Unknown', 'Movie')).toBe(true);
    expect(typesAgree('TV', null)).toBe(true);
  });
});

describe('pickBestMatch', () => {
  const yona = [
    c(25013, 'Akatsuki no Yona', { title_english: 'Yona of the Dawn', episodes: 24 }),
    c(60000, 'Akatsuki no Yona Season 2', { title_english: 'Yona of the Dawn Season 2', episodes: 12 }),
    c(30016, 'Akatsuki no Yona OVA', { type: 'OVA', episodes: 3 }),
  ];

  it('keeps a first season and its sequel apart', () => {
    expect(pickBestMatch('Akatsuki no Yona', 'TV', 24, yona)).toMatchObject({ malId: 25013, confidence: 'exact' });
    expect(pickBestMatch('Akatsuki no Yona Season 2', 'TV', null, yona)).toMatchObject({
      malId: 60000,
      confidence: 'exact',
    });
  });

  it('does not accept the first season when only it is on offer for a sequel', () => {
    const r = pickBestMatch('Akatsuki no Yona Season 2', 'TV', null, [yona[0]!, yona[2]!]);
    expect(r.confidence === 'low' || r.confidence === 'none').toBe(true);
  });

  it('matches a sequel named differently on MAL through its synonyms', () => {
    const candidates = [
      c(41457, '86', { title_english: '86 Eighty-Six', title_synonyms: ['Eighty Six'], episodes: 11 }),
      c(48569, '86 Part 2', {
        title_english: '86 Eighty-Six Part 2',
        title_synonyms: ['86 2nd Season', 'Eighty Six 2nd Season'],
        episodes: 12,
      }),
    ];
    expect(pickBestMatch('86: Eighty Six Part 2', 'TV', 12, candidates).malId).toBe(48569);
    expect(pickBestMatch('86: Eighty Six', 'TV', 11, candidates).malId).toBe(41457);
  });

  it('understands "2nd Season" and "Season 2" as the same instalment', () => {
    const candidates = [
      c(1, 'Goblin Slayer', { episodes: 12 }),
      c(2, 'Goblin Slayer II', { title_synonyms: ['Goblin Slayer Season 2'], episodes: 12 }),
    ];
    const r = pickBestMatch('Goblin Slayer 2nd Season', 'TV', 12, candidates);
    expect(r.malId).toBe(2);
  });

  it('prefers the candidate whose type agrees', () => {
    const candidates = [
      c(10, 'Kaijuu 8-gou', { type: 'TV', episodes: 12 }),
      c(11, 'Kaijuu 8-gou', { type: 'Movie', episodes: 1 }),
    ];
    expect(pickBestMatch('Kaijuu 8-gou', 'TV', 12, candidates)).toMatchObject({ malId: 10, confidence: 'exact' });
    expect(pickBestMatch('Kaijuu 8-gou', 'Movie', 1, candidates)).toMatchObject({ malId: 11, confidence: 'exact' });
  });

  it('prefers a main-title match over another entry that only matches by synonym', () => {
    const candidates = [
      c(20, 'Dororo to Hyakkimaru', { title_synonyms: ['Dororo'], episodes: 26, members: 9000 }),
      c(21, 'Dororo', { episodes: 24, members: 900000 }),
    ];
    expect(pickBestMatch('Dororo', 'TV', 24, candidates)).toMatchObject({ malId: 21, confidence: 'exact' });
  });

  it('marks a type mismatch as low confidence even when the title is identical', () => {
    const r = pickBestMatch('Some Show', 'TV', null, [c(30, 'Some Show', { type: 'OVA' })]);
    expect(r).toMatchObject({ malId: 30, confidence: 'low' });
  });

  it('reports the runner-up', () => {
    const r = pickBestMatch('Akatsuki no Yona', 'TV', 24, yona);
    expect(r.runnerUp?.malId).toBeDefined();
    expect(r.runnerUp!.score).toBeLessThan(r.score);
  });

  it('returns no match when nothing is close', () => {
    expect(pickBestMatch('Clannad', 'TV', 23, [c(40, 'Naruto'), c(41, 'Bleach')])).toMatchObject({
      malId: null,
      confidence: 'none',
    });
    expect(pickBestMatch('Clannad', 'TV', 23, [])).toMatchObject({ malId: null, confidence: 'none' });
  });

  it('accepts a near-identical title as high confidence', () => {
    const r = pickBestMatch('Yuusha Party ni Kawaii Ko ga Ita node, Kokuhaku shitemita.', 'TV', 13, [
      c(50, 'Yuusha Party ni Kawaii Ko ga Ita node, Kokuhaku Shite Mita.', { episodes: 13 }),
      c(51, 'Yuusha Party wo Tsuihou sareta Beast Tamer', { episodes: 13 }),
    ]);
    expect(r).toMatchObject({ malId: 50, confidence: 'high' });
  });
});

describe('shortenQuery / matchKey', () => {
  it('cuts long titles at a word boundary', () => {
    const long = 'Kyouran Reijou Nia Liston: Byoujaku Reijou ni Tensei shita Kamigoroshi no Bujin no Karei Naru Musouroku';
    const short = shortenQuery(long, 60);
    expect(short.length).toBeLessThanOrEqual(60);
    expect(long.startsWith(short)).toBe(true);
    expect(short.endsWith(' ')).toBe(false);
    expect(shortenQuery('Clannad', 60)).toBe('Clannad');
  });

  it('builds a cache key from title and type', () => {
    expect(matchKey('Angel Beats!', 'TV')).toBe('angel beats|TV');
  });
});

describe('parseDuration / toMalInfo', () => {
  it('parses MAL duration strings into minutes', () => {
    expect(parseDuration('24 min per ep')).toBe(24);
    expect(parseDuration('1 hr 55 min')).toBe(115);
    expect(parseDuration('2 hr')).toBe(120);
    expect(parseDuration('30 sec per ep')).toBe(0.5);
    expect(parseDuration('Unknown')).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });

  it('reduces a Jikan object to the fields the site uses', () => {
    const info = toMalInfo({
      mal_id: 6547,
      url: 'https://myanimelist.net/anime/6547/Angel_Beats',
      title: 'Angel Beats!',
      title_english: 'Angel Beats!',
      title_japanese: 'Angel Beats!',
      images: { webp: { image_url: 'https://cdn.myanimelist.net/a.webp', large_image_url: 'https://cdn.myanimelist.net/al.webp' } },
      type: 'TV',
      episodes: 13,
      status: 'Finished Airing',
      airing: false,
      aired: { from: '2010-04-03T00:00:00+00:00' },
      duration: '26 min per ep',
      score: 8.05,
      season: 'spring',
      year: null,
      studios: [{ name: 'P.A. Works' }],
      genres: [{ name: 'Drama' }, { name: 'Supernatural' }],
      themes: [{ name: 'School' }],
      demographics: [],
    });
    expect(info).toMatchObject({
      id: 6547,
      image: 'https://cdn.myanimelist.net/a.webp',
      imageLarge: 'https://cdn.myanimelist.net/al.webp',
      durationMin: 26,
      year: 2010,
      genres: ['Drama', 'Supernatural'],
      themes: ['School'],
      studios: ['P.A. Works'],
    });
  });
});

const row = (title: string, extra: Partial<OaEntry> = {}): OaEntry => ({
  oaId: null,
  slug: null,
  title,
  status: 'Completed',
  rawStatus: 'Obejrzane',
  score: 8,
  watched: 12,
  total: 12,
  type: 'TV',
  addedAt: null,
  ...extra,
});

describe('mergeSources', () => {
  const previous = [row('A', { oaId: 1, slug: 'a', addedAt: '2024-01-01T10:00:00' }), row('B', { oaId: 2, slug: 'b' })];

  it('uses the live list when it was fetched', () => {
    const html = [row('A', { oaId: 1, slug: 'a', score: 9 })];
    const r = mergeSources({ csv: [row('A')], csvIsNew: true, html: [...html, row('C', { oaId: 3 })], previous });
    expect(r.source).toBe('html');
    expect(r.entries).toHaveLength(2);
  });

  it('falls back to a new CSV and borrows slug and date from the previous data', () => {
    const r = mergeSources({ csv: [row('A', { score: 10 }), row('New')], csvIsNew: true, html: null, previous });
    expect(r.source).toBe('csv');
    expect(r.entries[0]).toMatchObject({ title: 'A', score: 10, slug: 'a', oaId: 1, addedAt: '2024-01-01T10:00:00' });
    expect(r.entries[1]).toMatchObject({ title: 'New', slug: null, addedAt: null });
  });

  it('keeps the previous data when the CSV was already processed and the page is blocked', () => {
    const r = mergeSources({ csv: [row('A')], csvIsNew: false, html: null, previous });
    expect(r.source).toBe('previous');
    expect(r.entries).toBe(previous);
  });

  it('ignores a live list that suddenly lost most of its rows', () => {
    const many = Array.from({ length: 10 }, (_, i) => row(`T${i}`, { oaId: i + 1 }));
    const r = mergeSources({ csv: null, csvIsNew: false, html: many.slice(0, 2), previous: many });
    expect(r.source).toBe('previous');
    expect(r.notes[0]).toMatch(/suspicious/);
  });

  it('drops duplicate rows', () => {
    const r = mergeSources({ csv: [row('A'), row('A'), row('A', { type: 'Movie' })], csvIsNew: true, html: null, previous: null });
    expect(r.entries).toHaveLength(2);
    expect(r.notes).toHaveLength(1);
  });

  it('throws when there is no data at all', () => {
    expect(() => mergeSources({ csv: null, csvIsNew: false, html: null, previous: null })).toThrow(/No list data/);
  });
});

describe('buildEntries', () => {
  const mal = (id: number): MalInfo => ({
    id,
    url: `https://myanimelist.net/anime/${id}`,
    title: `MAL ${id}`,
    titleEnglish: null,
    titleJapanese: null,
    image: null,
    imageLarge: null,
    type: 'TV',
    episodes: 12,
    durationMin: 24,
    airStatus: 'Finished Airing',
    airing: false,
    season: null,
    year: 2020,
    score: 7.5,
    genres: [],
    themes: [],
    demographics: [],
    studios: [],
  });

  it('keys by MAL id, then OA slug, then title, and keeps keys unique', () => {
    const rows = [row('B', { slug: 'b' }), row('A', { slug: 'a' }), row('C'), row('D', { slug: 'd' })];
    const entries = buildEntries(rows, (r) =>
      r.title === 'C'
        ? { mal: null, confidence: 'none', score: 0 }
        : { mal: mal(r.title === 'D' ? 1 : r.title === 'A' ? 1 : 2), confidence: 'exact', score: 1 },
    );
    expect(entries.map((e) => e.title)).toEqual(['A', 'B', 'C', 'D']);
    expect(entries.map((e) => e.key)).toEqual(['mal:1', 'mal:2', 'title:c', 'oa:d']);
  });
});

describe('baseTitle', () => {
  it.each([
    ['Akatsuki no Yona Season 2', 'Akatsuki no Yona'],
    ['Tensei shitara Slime Datta Ken 4th Season', 'Tensei shitara Slime Datta Ken'],
    ['86: Eighty Six Part 2', '86: Eighty Six'],
    ['Mob Psycho 100 II', 'Mob Psycho 100'],
    ['Xian Wang de Richang Shenghuo 4', 'Xian Wang de Richang Shenghuo'],
    ['Shingeki no Kyojin: The Final Season Part 2', 'Shingeki no Kyojin'],
    ['Maou Gakuin no Futekigousha II (2 Cour)', 'Maou Gakuin no Futekigousha'],
  ])('%s → %s', (title, expected) => {
    expect(baseTitle(title)).toBe(expected);
  });

  it('returns null when there is nothing to strip', () => {
    expect(baseTitle('Clannad')).toBeNull();
    expect(baseTitle('Mob Psycho 100')).toBeNull();
    expect(baseTitle('91 Days')).toBeNull();
    expect(baseTitle('Kaijuu 8-gou')).toBeNull();
  });
});

describe('AniList backup', () => {
  const media: AniListMedia = {
    id: 131586,
    idMal: 48569,
    format: 'TV',
    episodes: 12,
    duration: 24,
    status: 'FINISHED',
    season: 'FALL',
    seasonYear: 2021,
    popularity: 250000,
    title: { romaji: '86: Eighty Six Part 2', english: '86 EIGHTY-SIX Part 2', native: '86－エイティシックス－ 第2クール' },
    synonyms: ['86 2nd Season'],
    startDate: { year: 2021 },
    coverImage: {
      large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx131586-abc.jpg',
      extraLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx131586-abc.jpg',
    },
    genres: ['Action', 'Drama', 'Mecha', 'Sci-Fi'],
    studios: { nodes: [{ name: 'A-1 Pictures' }] },
  };

  it('builds one aliased search per title', () => {
    const q = buildSearchQuery(3);
    expect(q).toContain('query ($s0: String, $s1: String, $s2: String)');
    expect(q.match(/q\d: Page/g)).toEqual(['q0: Page', 'q1: Page', 'q2: Page']);
    expect(q).toContain('idMal');
  });

  it('turns an AniList entry into a matcher candidate keyed by MAL id', () => {
    expect(toCandidate(media)).toMatchObject({ mal_id: 48569, title: '86: Eighty Six Part 2', type: 'TV', episodes: 12 });
    expect(toCandidate({ ...media, idMal: null })).toBeNull();
    expect(toCandidate({ ...media, format: 'TV_SHORT' })!.type).toBe('TV');
    expect(pickBestMatch('86: Eighty Six Part 2', 'TV', 12, [toCandidate(media)!])).toMatchObject({ malId: 48569, confidence: 'exact' });
  });

  it('maps AniList fields onto the MAL shape and marks the source', () => {
    expect(aniListToMalInfo(media)).toEqual({
      id: 48569,
      url: 'https://myanimelist.net/anime/48569',
      title: '86: Eighty Six Part 2',
      titleEnglish: '86 EIGHTY-SIX Part 2',
      titleJapanese: '86－エイティシックス－ 第2クール',
      image: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx131586-abc.jpg',
      imageLarge: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx131586-abc.jpg',
      type: 'TV',
      episodes: 12,
      durationMin: 24,
      airStatus: 'Finished Airing',
      airing: false,
      season: 'fall',
      year: 2021,
      score: null,
      genres: ['Action', 'Drama', 'Mecha', 'Sci-Fi'],
      themes: [],
      demographics: [],
      studios: ['A-1 Pictures'],
      source: 'anilist',
    });
    expect(aniListToMalInfo({ ...media, status: 'RELEASING', seasonYear: null })).toMatchObject({ airing: true, year: 2021 });
  });

  it('searches several titles in one request and follows the rate-limit header', async () => {
    const calls: { query: string; variables: Record<string, string> }[] = [];
    const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ data: { q0: { media: [media] }, q1: { media: [] } } }), {
        status: 200,
        headers: { 'x-ratelimit-limit': '6000' },
      });
    }) as typeof fetch;
    const client = new AniListClient(fakeFetch);
    const results = await client.searchMany(['86: Eighty Six Part 2', 'Nothing']);
    expect(results.map((r) => r.length)).toEqual([1, 0]);
    expect(calls[0]!.variables).toEqual({ s0: '86: Eighty Six Part 2', s1: 'Nothing' });
    expect(client.requests).toBe(1);
  });

  it('gives up with a clear error when AniList keeps failing', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 400 })) as typeof fetch;
    await expect(new AniListClient(fakeFetch).searchMany(['x'])).rejects.toBeInstanceOf(AniListUnavailableError);
  });
});

describe('catalogue decorations, years and naming variants', () => {
  it('strips "(TV)", years and brackets, keeping the year as a hint', () => {
    expect(cleanTitle('Jujutsu Kaisen (TV)')).toEqual({ title: 'Jujutsu Kaisen', year: null });
    expect(cleanTitle('Sugar Apple Fairy Tale (2023)')).toEqual({ title: 'Sugar Apple Fairy Tale', year: 2023 });
    expect(cleanTitle('Hazure Waku no [Joutai Ijou Skill] de')).toEqual({ title: 'Hazure Waku no Joutai Ijou Skill de', year: null });
    expect(cleanTitle('Darwin`s Game').title).toBe("Darwin's Game");
    expect(cleanTitle('Clannad')).toEqual({ title: 'Clannad', year: null });
  });

  it('matches a decorated title to the plain one', () => {
    const r = pickBestMatch('Jujutsu Kaisen (TV)', 'TV', 24, [c(1, 'Jujutsu Kaisen', { episodes: 24 }), c(2, 'Jujutsu Kaisen 0', { type: 'Movie' })]);
    expect(r).toMatchObject({ malId: 1, confidence: 'exact' });
  });

  it('treats "2nd Season" and a bare "2" as the same instalment', () => {
    const candidates = [c(1, 'Boku no Hero Academia', { episodes: 13 }), c(2, 'Boku no Hero Academia 2', { episodes: 25 })];
    expect(pickBestMatch('Boku no Hero Academia 2nd Season', 'TV', 25, candidates)).toMatchObject({ malId: 2, confidence: 'high' });
    expect(pickBestMatch('Tensei shitara Slime Datta Ken 3', 'TV', 24, [c(3, 'Tensei Shitara Slime Datta Ken 3rd Season')])).toMatchObject({
      malId: 3,
      confidence: 'high',
    });
  });

  it('reads a number before a subtitle as the season', () => {
    expect(sequelSignature('Nanatsu no Taizai 3: Kamigami no Gekirin')).toEqual({ season: 3, part: 1 });
    expect(sequelSignature('86: Eighty Six')).toEqual({ season: 1, part: 1 });
  });

  it('uses identical spelling to separate titles that differ only in punctuation', () => {
    const candidates = [c(1, 'Hataraku Maou-sama!', { episodes: 13 }), c(2, 'Hataraku Maou-sama!!', { episodes: 12 })];
    expect(pickBestMatch('Hataraku Maou-sama!', 'TV', 13, candidates)).toMatchObject({ malId: 1, confidence: 'exact' });
    expect(pickBestMatch('Hataraku Maou-sama!!', 'TV', 12, candidates)).toMatchObject({ malId: 2, confidence: 'exact' });
  });

  it('uses a year in the title as a hint and never trusts a match from another year', () => {
    const candidates = [c(1, 'Sugar Apple Fairy Tale', { year: 2023 }), c(2, 'Sugar Apple Fairy Tale Part 2', { year: 2023 })];
    expect(pickBestMatch('Sugar Apple Fairy Tale (2023)', 'TV', null, candidates)).toMatchObject({ malId: 1, confidence: 'exact' });
    const wrongYear = pickBestMatch('Some Show (2023)', 'TV', null, [c(5, 'Some Show', { year: 2011 })]);
    expect(wrongYear).toMatchObject({ malId: 5, confidence: 'low' });
  });

  it('can treat TV and ONA as the same thing when the source is known to disagree', () => {
    const ona = [c(1, 'Sakamoto Days', { type: 'ONA' })];
    expect(pickBestMatch('Sakamoto Days', 'TV', null, ona).confidence).toBe('low');
    expect(pickBestMatch('Sakamoto Days', 'TV', null, ona, { lenientTypes: true }).confidence).toBe('exact');
    // Even leniently, a series is never an OVA and a film is never a series.
    expect(typesAgree('TV', 'OVA', true)).toBe(false);
    expect(typesAgree('TV', 'Movie', true)).toBe(false);
    expect(typesAgree('Special', 'OVA')).toBe(true);
    expect(typesAgree('ONA', 'OVA', true)).toBe(true);
  });

  it('builds progressively looser search queries without repeats', () => {
    expect(searchQueries('Clannad')).toEqual(['Clannad']);
    expect(searchQueries('Jujutsu Kaisen (TV) 2nd Season')).toEqual(['Jujutsu Kaisen 2nd Season', 'Jujutsu Kaisen']);
    const long = searchQueries('Tensei shitara Dainana Ouji Datta node, Kimama ni Majutsu wo Kiwamemasu 2');
    expect(long[0]!.length).toBeLessThanOrEqual(60);
    expect(long).toContain('Tensei shitara Dainana');
    expect(long).toContain('Majutsu wo Kiwamemasu');
    expect(new Set(long).size).toBe(long.length);
  });
});
