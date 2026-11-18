/**
 * Title search for the "Add anime" tab. Runs in the admin's browser and asks AniList,
 * which carries the MAL id of every entry, so a hand-added title links to MyAnimeList
 * and keeps the same key as it would on my OglądajAnime list.
 */
import { sanitizeEntry, type ManualEntry } from './entries';
import type { AnimeType } from './types';

const ENDPOINT = 'https://graphql.anilist.co';
const QUERY = `query ($q: String) {
  Page(perPage: 10) {
    media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
      idMal format episodes duration status seasonYear
      startDate { year }
      title { romaji english }
      coverImage { large }
      genres
      studios(isMain: true) { nodes { name } }
    }
  }
}`;

interface Media {
  idMal: number | null;
  format: string | null;
  episodes: number | null;
  duration: number | null;
  status: string | null;
  seasonYear: number | null;
  startDate: { year: number | null } | null;
  title: { romaji: string | null; english: string | null };
  coverImage: { large: string | null } | null;
  genres: string[] | null;
  studios: { nodes: { name: string }[] } | null;
}

const FORMAT: Record<string, AnimeType> = {
  TV: 'TV',
  TV_SHORT: 'TV',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
};

/** A search result: everything an entry needs except my status, progress and date. */
export type Candidate = Omit<ManualEntry, 'status' | 'watched' | 'added'> & {
  /** AniList's airing status, shown to tell sequels and remakes apart. */
  airing: string | null;
};

export function toCandidate(m: Media): Candidate | null {
  const title = m.title.romaji ?? m.title.english;
  const entry = sanitizeEntry({
    malId: m.idMal,
    title,
    titleEn: m.title.english && m.title.english !== title ? m.title.english : null,
    image: m.coverImage?.large ?? null,
    type: m.format ? (FORMAT[m.format] ?? 'Unknown') : 'Unknown',
    total: m.episodes,
    genres: m.genres ?? [],
    year: m.seasonYear ?? m.startDate?.year ?? null,
    studio: m.studios?.nodes[0]?.name ?? null,
    duration: m.duration,
  });
  if (!entry) return null; // no MAL id or no title: cannot be linked or keyed
  const { status: _s, watched: _w, added: _a, ...rest } = entry;
  return { ...rest, airing: m.status };
}

/** Up to ten matches for a title, best match first. Throws with a readable message on failure. */
export async function searchAnime(q: string, fetchImpl: typeof fetch = fetch): Promise<Candidate[]> {
  const res = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { q } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) throw new Error('AniList asks to slow down; try again in a minute.');
  if (!res.ok) throw new Error(`AniList answered HTTP ${res.status}.`);
  const body = (await res.json()) as { data?: { Page?: { media?: Media[] } } };
  return (body.data?.Page?.media ?? []).map(toCandidate).filter((c): c is Candidate => c !== null);
}
