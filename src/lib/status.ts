import type { AnimeType, Status } from './types';

/** OglądajAnime status label (Polish) → English status. */
const STATUS_MAP: Record<string, Status> = {
  'oglądam': 'Watching',
  'obejrzane': 'Completed',
  'planuje': 'Plan to Watch',
  'planuję': 'Plan to Watch',
  'wstrzymane': 'On Hold',
  'porzucone': 'Dropped',
};

/**
 * Map an OA status label to an English status.
 *
 * "Nie oglądam" ("not watching") is what OA shows for entries that have progress
 * but were never put on a status list. It has no direct equivalent, so it is
 * resolved from progress: everything watched → Completed, otherwise → On Hold.
 */
export function mapStatus(raw: string, watched = 0, total: number | null = null): Status {
  const key = raw.trim().toLowerCase();
  const mapped = STATUS_MAP[key];
  if (mapped) return mapped;
  if (key === 'nie oglądam') {
    return total !== null && total > 0 && watched >= total ? 'Completed' : 'On Hold';
  }
  throw new Error(`Unknown OglądajAnime status: "${raw}"`);
}

const TYPE_MAP: Record<string, AnimeType> = {
  tv: 'TV',
  movie: 'Movie',
  film: 'Movie',
  ova: 'OVA',
  ona: 'ONA',
  special: 'Special',
};

export function mapType(raw: string): AnimeType {
  return TYPE_MAP[raw.trim().toLowerCase()] ?? 'Unknown';
}

/** "10" → 10; "-", "0" and "" → null (not rated). */
export function parseScore(raw: string): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

/** "15/24" → { watched: 15, total: 24 }; a total of 0 means "unknown". */
export function parseProgress(raw: string): { watched: number; total: number | null } {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  if (!m) return { watched: 0, total: null };
  const watched = Number(m[1]);
  const total = Number(m[2]);
  return { watched, total: total > 0 ? total : null };
}
