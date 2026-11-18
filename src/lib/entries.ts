/**
 * Titles I add by hand in the admin panel: anime that are not on my OglądajAnime list.
 *
 * They live in the database (not in data/anime.json), so the sync never touches them.
 * The page merges them into the list. If a title later shows up on my OglądajAnime list,
 * that row takes over and the hand-added copy is no longer shown; my notes stay attached
 * because both are keyed by the same MAL id.
 */
import { imageUrl } from './annotations';
import type { ListItem } from './model';
import { ANIME_TYPES, STATUSES, type AnimeType, type Status } from './types';

export interface ManualEntry {
  malId: number;
  title: string;
  titleEn: string | null;
  /** Cover, ~230px wide (AniList or MAL CDN). */
  image: string | null;
  type: AnimeType;
  status: Status;
  watched: number;
  /** Episode count; null while unknown (for example, still airing). */
  total: number | null;
  /** When I added it: `YYYY-MM-DDTHH:MM:SS`, local time, like the OglądajAnime dates. */
  added: string;
  genres: string[];
  year: number | null;
  studio: string | null;
  /** Minutes per episode. */
  duration: number | null;
}

export const ENTRY_LIMITS = { title: 200, studio: 80, genre: 32, genres: 12, episodes: 5000, duration: 600 } as const;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return t === '' ? null : t;
};
const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;

const pad = (n: number) => String(n).padStart(2, '0');
/** Now, as a local `YYYY-MM-DDTHH:MM:SS`. */
export function nowLocal(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Coerce untrusted input into a valid entry, or null when the essentials (MAL id, title) are missing. */
export function sanitizeEntry(raw: unknown): ManualEntry | null {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const malId = int(r.malId, 1, 10_000_000);
  const title = text(r.title, ENTRY_LIMITS.title);
  if (malId === null || title === null) return null;
  const total = int(r.total, 1, ENTRY_LIMITS.episodes);
  const watchedRaw = int(r.watched, 0, ENTRY_LIMITS.episodes) ?? 0;
  const duration = typeof r.duration === 'number' && r.duration > 0 && r.duration <= ENTRY_LIMITS.duration ? Math.round(r.duration * 100) / 100 : null;
  return {
    malId,
    title,
    titleEn: text(r.titleEn, ENTRY_LIMITS.title),
    image: imageUrl(r.image),
    type: (ANIME_TYPES as readonly unknown[]).includes(r.type) ? (r.type as AnimeType) : 'Unknown',
    status: (STATUSES as readonly unknown[]).includes(r.status) ? (r.status as Status) : 'Completed',
    watched: total !== null ? Math.min(watchedRaw, total) : watchedRaw,
    total,
    added: typeof r.added === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(r.added) ? r.added : nowLocal(),
    genres: Array.isArray(r.genres)
      ? [...new Set(r.genres.map((g) => text(g, ENTRY_LIMITS.genre)).filter((g): g is string => g !== null))].slice(0, ENTRY_LIMITS.genres)
      : [],
    year: int(r.year, 1900, 2100),
    studio: text(r.studio, ENTRY_LIMITS.studio),
    duration,
  };
}

/** A list of entries from untrusted input: invalid ones dropped, one per MAL id. */
export function sanitizeEntries(raw: unknown): ManualEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: ManualEntry[] = [];
  for (const r of raw) {
    const e = sanitizeEntry(r);
    if (e && !seen.has(e.malId)) {
      seen.add(e.malId);
      out.push(e);
    }
  }
  return out;
}

export function entryToItem(e: ManualEntry): ListItem {
  return {
    key: `mal:${e.malId}`,
    altKey: null,
    title: e.title,
    titleEn: e.titleEn,
    malId: e.malId,
    image: e.image,
    status: e.status,
    // Hand-added titles have no OglądajAnime score; my own 1–100 score lives in the notes.
    score: null,
    watched: e.watched,
    total: e.total,
    type: e.type,
    added: e.added,
    genres: e.genres,
    year: e.year,
    malScore: null,
    studio: e.studio,
    duration: e.duration,
    manual: true,
  };
}

/** The list with my hand-added titles appended. A title that is already on the list is not added twice. */
export function mergeEntries(items: ListItem[], entries: ManualEntry[]): ListItem[] {
  const onList = new Set(items.flatMap((i) => (i.malId !== null ? [i.malId] : [])));
  return [...items, ...entries.filter((e) => !onList.has(e.malId)).map(entryToItem)];
}

/** Hand-added titles that have since appeared on my OglądajAnime list. */
export function supersededEntries(items: ListItem[], entries: ManualEntry[]): Set<number> {
  const onList = new Set(items.filter((i) => !i.manual).flatMap((i) => (i.malId !== null ? [i.malId] : [])));
  return new Set(entries.filter((e) => onList.has(e.malId)).map((e) => e.malId));
}

export const entriesFingerprint = (entries: ManualEntry[]): string =>
  JSON.stringify([...entries].sort((a, b) => a.malId - b.malId));
