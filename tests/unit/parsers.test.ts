import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dateFromCsvName, decodeCsv, parseCsvRows, parseOaCsv } from '../../scripts/lib/csv';
import { decodeEntities, looksBlocked, parseOaListHtml, robotsAllows } from '../../scripts/lib/oa-html';
import { mapStatus, mapType, parseProgress, parseScore } from '../../src/lib/status';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

describe('parseCsvRows', () => {
  it('handles quotes, doubled quotes, commas and newlines inside fields', () => {
    const rows = parseCsvRows('"a","b ""quoted"", with comma","multi\nline"\r\nplain,2,3\n');
    expect(rows).toEqual([
      ['a', 'b "quoted", with comma', 'multi\nline'],
      ['plain', '2', '3'],
    ]);
  });

  it('strips a BOM and ignores a trailing blank line', () => {
    expect(parseCsvRows('﻿"x","y"\n\n')).toEqual([['x', 'y']]);
  });
});

describe('decodeCsv', () => {
  it('reads UTF-8', () => {
    expect(decodeCsv(new TextEncoder().encode('Tytuł,Postęp'))).toBe('Tytuł,Postęp');
  });

  it('falls back to Windows-1250 when the bytes are not valid UTF-8', () => {
    // "Tytuł" in Windows-1250: ł = 0xB3
    expect(decodeCsv(new Uint8Array([0x54, 0x79, 0x74, 0x75, 0xb3]))).toBe('Tytuł');
  });
});

describe('parseOaCsv (real export sample)', () => {
  const entries = parseOaCsv(decodeCsv(fixture('oa-export.csv')));

  it('parses every data row', () => {
    expect(entries).toHaveLength(21);
  });

  it('reads title, status, score, progress and type', () => {
    expect(entries[0]).toEqual({
      oaId: null,
      slug: null,
      title: '86: Eighty Six',
      status: 'Completed',
      rawStatus: 'Obejrzane',
      score: 10,
      watched: 11,
      total: 11,
      type: 'TV',
      addedAt: null,
    });
  });

  it('keeps a score on a Plan to Watch entry and treats 0/0 as unknown progress', () => {
    const yona2 = entries.find((e) => e.title === 'Akatsuki no Yona Season 2')!;
    expect(yona2).toMatchObject({ status: 'Plan to Watch', score: 10, watched: 0, total: null });
  });

  it('treats "-" as not rated', () => {
    expect(entries.find((e) => e.title === '91 Days')!.score).toBeNull();
  });

  it('keeps titles with commas and brackets intact', () => {
    expect(entries.some((e) => e.title.startsWith('[Omae Gotoki ga Maou ni Kateru to Omouna] to Yuusha Party'))).toBe(true);
  });

  it('fails loudly when a required column is missing', () => {
    expect(() => parseOaCsv('"#","Tytuł","Status"\n"1","X","Obejrzane"\n')).toThrow(/missing the "ocena" column/);
  });

  it('accepts columns in a different order', () => {
    const [e] = parseOaCsv('Typ,Postęp,Ocena,Status,Tytuł\nMovie,1/1,7,Obejrzane,Some Film\n');
    expect(e).toMatchObject({ title: 'Some Film', type: 'Movie', score: 7, status: 'Completed' });
  });
});

describe('dateFromCsvName', () => {
  it('reads the export date from the file name', () => {
    expect(dateFromCsvName('moja lista ogladajanime.pl_14.11.2026.csv')).toBe('2026-11-14');
    expect(dateFromCsvName('list-2026-03-01.csv')).toBe('2026-03-01');
    expect(dateFromCsvName('list.csv')).toBeNull();
  });
});

describe('parseOaListHtml (real page sample)', () => {
  const entries = parseOaListHtml(fixture('oa-list.html').toString('utf8'));

  it('finds every row', () => {
    expect(entries.map((e) => e.title)).toEqual([
      '86: Eighty Six',
      'Akatsuki no Yona Season 2',
      'Goblin Slayer 2nd Season',
      'Yuusha-kei ni Shosu: Choubatsu Yuusha 9004-tai Keimu Kiroku',
    ]);
  });

  it('reads OA id, slug and date added, which the CSV does not have', () => {
    expect(entries[0]).toEqual({
      oaId: 15472,
      slug: '86-eighty-six',
      title: '86: Eighty Six',
      status: 'Completed',
      rawStatus: 'Obejrzane',
      score: 10,
      watched: 11,
      total: 11,
      type: 'TV',
      addedAt: '2024-01-16T19:48:52',
    });
  });

  it('treats a score of 0 as not rated', () => {
    expect(entries[3]).toMatchObject({ score: null, watched: 3, total: 12, status: 'Watching' });
  });

  it('resolves "Nie oglądam" from progress', () => {
    expect(entries[2]).toMatchObject({ rawStatus: 'Nie oglądam', status: 'Completed' });
  });

  it('returns nothing for a page without the list', () => {
    expect(parseOaListHtml('<html><body>Just a moment...</body></html>')).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('Fate&#039;s &amp; &quot;K&quot; &#x41;&nbsp;B')).toBe('Fate\'s & "K" A B');
  });
});

describe('looksBlocked', () => {
  it('accepts a normal page', () => {
    expect(looksBlocked(200, new Headers(), '<tr id="anime_list_item_1">')).toBeNull();
  });

  it('detects Cloudflare challenges and error statuses', () => {
    expect(looksBlocked(403, new Headers({ 'cf-mitigated': 'challenge' }), '')).toMatch(/Cloudflare/);
    expect(looksBlocked(503, new Headers(), '')).toBe('HTTP 503');
    expect(looksBlocked(200, new Headers(), '<title>Just a moment...</title>')).toBe('bot-check page');
  });
});

describe('robotsAllows', () => {
  it('allows everything for an empty Disallow (the real OA robots.txt)', () => {
    expect(robotsAllows('User-agent: *\nDisallow:\n', '/anime_list/194074')).toBe(true);
  });

  it('respects a matching Disallow and a more specific Allow', () => {
    const txt = 'User-agent: *\nDisallow: /anime_list/\nAllow: /anime_list/194074\n';
    expect(robotsAllows(txt, '/anime_list/1')).toBe(false);
    expect(robotsAllows(txt, '/anime_list/194074')).toBe(true);
  });

  it('prefers a group addressed to our user agent', () => {
    const txt = 'User-agent: *\nDisallow:\n\nUser-agent: AxowskyAnimeListSync\nDisallow: /\n';
    expect(robotsAllows(txt, '/anime_list/194074')).toBe(false);
  });

  it('blocks everything on "Disallow: /"', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n', '/anime_list/194074')).toBe(false);
  });
});

describe('status mapping', () => {
  it.each([
    ['Oglądam', 'Watching'],
    ['Obejrzane', 'Completed'],
    ['Planuje', 'Plan to Watch'],
    ['Wstrzymane', 'On Hold'],
    ['Porzucone', 'Dropped'],
    ['  obejrzane ', 'Completed'],
  ] as const)('%s → %s', (raw, expected) => {
    expect(mapStatus(raw)).toBe(expected);
  });

  it('maps "Nie oglądam" to Completed when fully watched, otherwise On Hold', () => {
    expect(mapStatus('Nie oglądam', 12, 12)).toBe('Completed');
    expect(mapStatus('Nie oglądam', 3, 12)).toBe('On Hold');
    expect(mapStatus('Nie oglądam', 3, null)).toBe('On Hold');
  });

  it('rejects an unknown status instead of guessing', () => {
    expect(() => mapStatus('Coś nowego')).toThrow(/Unknown OglądajAnime status/);
  });

  it('maps types, scores and progress', () => {
    expect(mapType('TV')).toBe('TV');
    expect(mapType('movie')).toBe('Movie');
    expect(mapType('Music')).toBe('Unknown');
    expect(parseScore('10')).toBe(10);
    expect(parseScore('-')).toBeNull();
    expect(parseScore('0')).toBeNull();
    expect(parseScore('11')).toBeNull();
    expect(parseProgress('15/24')).toEqual({ watched: 15, total: 24 });
    expect(parseProgress('0/0')).toEqual({ watched: 0, total: null });
    expect(parseProgress('garbage')).toEqual({ watched: 0, total: null });
  });
});
