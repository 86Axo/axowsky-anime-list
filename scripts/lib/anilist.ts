/**
 * AniList: the backup metadata source, used only while Jikan is unreachable.
 *
 * AniList is free and keyless, and every entry carries its MyAnimeList id
 * (`idMal`), so titles are still keyed and linked by MAL id. What AniList cannot
 * provide is the MAL score; that stays empty until Jikan is back, at which point
 * the sync replaces AniList data with MAL data entry by entry.
 */
import type { MalInfo } from '../../src/lib/types';
import type { Candidate } from './match';

const ENDPOINT = 'https://graphql.anilist.co';
const MAX_ATTEMPTS = 4;
/** Titles looked up per GraphQL request (one aliased `Page` each). */
export const BATCH_SIZE = 8;
const PER_TITLE = 10;

export class AniListUnavailableError extends Error {}

export interface AniListMedia {
  id: number;
  idMal: number | null;
  format: string | null;
  episodes: number | null;
  duration: number | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  popularity: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[] | null;
  startDate: { year: number | null } | null;
  coverImage: { large: string | null; extraLarge: string | null } | null;
  genres: string[] | null;
  studios: { nodes: { name: string }[] } | null;
}

const FIELDS = `id idMal format episodes duration status season seasonYear popularity
title { romaji english native } synonyms startDate { year }
coverImage { large extraLarge } genres studios(isMain: true) { nodes { name } }`;

/** One request that searches several titles at once, each under its own alias. */
export function buildSearchQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$s${i}: String`).join(', ');
  const pages = Array.from(
    { length: count },
    (_, i) => `q${i}: Page(perPage: ${PER_TITLE}) { media(search: $s${i}, type: ANIME) { ${FIELDS} } }`,
  ).join('\n');
  return `query (${vars}) {\n${pages}\n}`;
}

const FORMAT_TO_MAL_TYPE: Record<string, string> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
};

const STATUS_TO_MAL: Record<string, string> = {
  FINISHED: 'Finished Airing',
  RELEASING: 'Currently Airing',
  NOT_YET_RELEASED: 'Not yet aired',
  CANCELLED: 'Finished Airing',
  HIATUS: 'Currently Airing',
};

export const aniListType = (m: AniListMedia): string | null => (m.format ? (FORMAT_TO_MAL_TYPE[m.format] ?? null) : null);

/** Shape an AniList entry like a Jikan candidate so the same matcher scores both. Entries without a MAL id are skipped. */
export function toCandidate(m: AniListMedia): Candidate | null {
  const title = m.title.romaji ?? m.title.english;
  if (m.idMal === null || !title) return null;
  return {
    mal_id: m.idMal,
    title,
    title_english: m.title.english,
    title_synonyms: m.synonyms ?? [],
    type: aniListType(m),
    episodes: m.episodes,
    members: m.popularity,
    year: m.seasonYear ?? m.startDate?.year ?? null,
  };
}

export function aniListToMalInfo(m: AniListMedia): MalInfo {
  if (m.idMal === null) throw new Error(`AniList entry ${m.id} has no MAL id`);
  return {
    id: m.idMal,
    url: `https://myanimelist.net/anime/${m.idMal}`,
    title: m.title.romaji ?? m.title.english ?? `MAL ${m.idMal}`,
    titleEnglish: m.title.english,
    titleJapanese: m.title.native,
    image: m.coverImage?.large ?? null,
    imageLarge: m.coverImage?.extraLarge ?? m.coverImage?.large ?? null,
    type: aniListType(m),
    episodes: m.episodes,
    durationMin: m.duration,
    airStatus: m.status ? (STATUS_TO_MAL[m.status] ?? null) : null,
    airing: m.status === 'RELEASING',
    season: m.season ? m.season.toLowerCase() : null,
    year: m.seasonYear ?? m.startDate?.year ?? null,
    // AniList has its own score scale and voters; it is not shown as a MAL score.
    score: null,
    genres: m.genres ?? [],
    themes: [],
    demographics: [],
    studios: (m.studios?.nodes ?? []).map((s) => s.name),
    source: 'anilist',
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AniListClient {
  private lastRequestAt = 0;
  /** AniList allows 90 requests/minute, 30 while it runs in its degraded mode. Start slow, follow the header. */
  private minIntervalMs = 2200;
  requests = 0;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      this.requests++;
      try {
        const res = await this.fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(30_000),
        });
        const limit = Number(res.headers.get('x-ratelimit-limit'));
        if (Number.isFinite(limit) && limit > 0) this.minIntervalMs = Math.ceil(60_000 / limit) + 200;
        if (res.ok) {
          const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
          if (body.data) return body.data;
          lastError = body.errors?.[0]?.message ?? 'empty response';
        } else {
          lastError = `HTTP ${res.status}`;
          if (res.status === 429) {
            const retryAfter = Number(res.headers.get('retry-after'));
            await sleep(Math.min((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000, 90_000));
            continue;
          }
          if (res.status < 500) break; // a 4xx other than 429 will not get better by retrying
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
      await sleep(Math.min(2000 * 2 ** (attempt - 1), 20_000));
    }
    throw new AniListUnavailableError(`AniList request failed (${lastError})`);
  }

  /** Search several titles in one request. Returns one result list per title, in order. */
  async searchMany(titles: string[]): Promise<AniListMedia[][]> {
    if (titles.length === 0) return [];
    const variables = Object.fromEntries(titles.map((t, i) => [`s${i}`, t]));
    const data = await this.post<Record<string, { media: AniListMedia[] } | null>>(buildSearchQuery(titles.length), variables);
    return titles.map((_, i) => data[`q${i}`]?.media ?? []);
  }

  /** Look entries up by MAL id (used for manual overrides). */
  async byMalIds(ids: number[]): Promise<AniListMedia[]> {
    if (ids.length === 0) return [];
    const data = await this.post<{ Page: { media: AniListMedia[] } | null }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(idMal_in: $ids, type: ANIME) { ${FIELDS} } } }`,
      { ids },
    );
    return data.Page?.media ?? [];
  }
}
