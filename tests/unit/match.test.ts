import { describe, expect, it } from 'vitest';
import { parseDuration, toMalInfo } from '../../scripts/lib/jikan';
import {
  diceSimilarity,
  matchKey,
  normalizeTitle,
  pickBestMatch,
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
