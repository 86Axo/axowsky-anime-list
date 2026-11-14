import type { MalInfo } from '../../src/lib/types';
import type { Candidate } from './match';

const BASE = 'https://api.jikan.moe/v4';

/** Jikan allows 3 requests/second and 60/minute. One request every 1.1 s stays under both. */
const MIN_INTERVAL_MS = 1100;
const MAX_ATTEMPTS = 5;

export class JikanUnavailableError extends Error {}

export interface JikanAnime extends Candidate {
  url: string;
  images?: {
    jpg?: { image_url?: string | null; small_image_url?: string | null; large_image_url?: string | null };
    webp?: { image_url?: string | null; small_image_url?: string | null; large_image_url?: string | null };
  };
  title_japanese?: string | null;
  status?: string | null;
  airing?: boolean;
  aired?: { from?: string | null } | null;
  duration?: string | null;
  score?: number | null;
  season?: string | null;
  year?: number | null;
  studios?: { name: string }[];
  genres?: { name: string }[];
  themes?: { name: string }[];
  demographics?: { name: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JikanClient {
  private lastRequestAt = 0;
  requests = 0;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly minIntervalMs = MIN_INTERVAL_MS,
  ) {}

  private async get<T>(path: string): Promise<T | null> {
    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      this.requests++;
      try {
        const res = await this.fetchImpl(BASE + path, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 404) return null;
        if (res.ok) return (await res.json()) as T;
        lastError = `HTTP ${res.status}`;
        // 429 = rate limited, 5xx = Jikan or MAL hiccup: back off and retry.
        if (res.status !== 429 && res.status < 500) throw new Error(`Jikan ${path}: HTTP ${res.status}`);
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (attempt - 1);
        await sleep(Math.min(backoff, 60_000));
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Jikan ')) throw err;
        lastError = (err as Error).message;
        await sleep(Math.min(2000 * 2 ** (attempt - 1), 30_000));
      }
    }
    throw new JikanUnavailableError(`Jikan ${path} failed after ${MAX_ATTEMPTS} attempts (${lastError})`);
  }

  async search(query: string, type: string | null, limit = 10): Promise<JikanAnime[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (type) params.set('type', type);
    const res = await this.get<{ data?: JikanAnime[] }>(`/anime?${params}`);
    return res?.data ?? [];
  }

  async byId(id: number): Promise<JikanAnime | null> {
    const res = await this.get<{ data?: JikanAnime }>(`/anime/${id}`);
    return res?.data ?? null;
  }
}

/** "24 min per ep" → 24, "1 hr 55 min" → 115, "45 sec" → 0.75, "Unknown" → null. */
export function parseDuration(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const hr = /(\d+)\s*hr/.exec(raw);
  const min = /(\d+)\s*min/.exec(raw);
  const sec = /(\d+)\s*sec/.exec(raw);
  if (!hr && !min && !sec) return null;
  const total = Number(hr?.[1] ?? 0) * 60 + Number(min?.[1] ?? 0) + Number(sec?.[1] ?? 0) / 60;
  return Math.round(total * 100) / 100;
}

/** Year a Jikan entry started airing (MAL only fills `year` for seasonal shows). */
export function jikanYear(a: JikanAnime): number | null {
  const aired = a.aired?.from ? Number(a.aired.from.slice(0, 4)) : null;
  return a.year ?? (aired !== null && Number.isFinite(aired) ? aired : null);
}

/** Reduce a Jikan anime object to the fields the site uses. */
export function toMalInfo(a: JikanAnime): MalInfo {
  const names = (list: { name: string }[] | undefined) => (list ?? []).map((x) => x.name);
  return {
    id: a.mal_id,
    url: a.url ?? `https://myanimelist.net/anime/${a.mal_id}`,
    title: a.title,
    titleEnglish: a.title_english ?? null,
    titleJapanese: a.title_japanese ?? null,
    image: a.images?.webp?.image_url ?? a.images?.jpg?.image_url ?? null,
    imageLarge: a.images?.webp?.large_image_url ?? a.images?.jpg?.large_image_url ?? null,
    type: a.type ?? null,
    episodes: a.episodes ?? null,
    durationMin: parseDuration(a.duration),
    airStatus: a.status ?? null,
    airing: a.airing ?? false,
    season: a.season ?? null,
    year: jikanYear(a),
    score: a.score ?? null,
    genres: names(a.genres),
    themes: names(a.themes),
    demographics: names(a.demographics),
    studios: names(a.studios),
  };
}
