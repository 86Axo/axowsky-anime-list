/**
 * Rating system: the single place to edit thresholds, labels and tier names.
 *
 * A final score is 1–100. It is my refined score when I set one, otherwise my
 * OglądajAnime score (1–10) × SCORE_MULTIPLIER.
 *
 * Tiers are checked top to bottom; the first whose `min` is ≤ the score wins.
 * Tier colors live in src/styles/tokens.css as `--tier-<id>-*` custom properties.
 */
export const SCORE_MULTIPLIER = 10;

export interface Tier {
  /** CSS-safe id, used for `--tier-<id>-*` variables and the tier filter. */
  id: string;
  /** Badge text. */
  name: string;
  /** Lowest score (inclusive) that still lands in this tier. */
  min: number;
  label: string;
}

// I rate strictly: 50 already means "OK", and most titles land between 50 and 70.
// So the scale is finest in the middle and at the bottom, and coarse at the top:
// half-steps from 50 to 79, and a separate tier for each low score instead of one "bad" bucket.
// Every OglądajAnime score (1–10) lands in a tier of its own; the "+" tiers in between
// are reached with a refined score (65 → C+).
export const TIERS: readonly Tier[] = [
  { id: 'sp', name: 'S+', min: 95, label: 'Masterpiece' },
  { id: 's', name: 'S', min: 90, label: 'Exceptional' },
  { id: 'a', name: 'A', min: 80, label: 'Great' },
  { id: 'bp', name: 'B+', min: 75, label: 'Very good' },
  { id: 'b', name: 'B', min: 70, label: 'Good' },
  { id: 'cp', name: 'C+', min: 65, label: 'Enjoyable' },
  { id: 'c', name: 'C', min: 60, label: 'Decent' },
  { id: 'dp', name: 'D+', min: 55, label: 'Fine' },
  { id: 'd', name: 'D', min: 50, label: 'OK' },
  { id: 'e', name: 'E', min: 40, label: 'Weak' },
  { id: 'fp', name: 'F+', min: 30, label: 'Poor' },
  { id: 'f', name: 'F', min: 20, label: 'Bad' },
  { id: 'fm', name: 'F−', min: 1, label: 'Awful' },
];

/** The top tier gets a special look on the page. */
export const TOP_TIER_ID = 'sp';

/** OA score (1–10) → 1–100. */
export function convertScore(oaScore: number | null): number | null {
  if (oaScore === null || !Number.isFinite(oaScore)) return null;
  return clampScore(Math.round(oaScore * SCORE_MULTIPLIER));
}

/** Refined score wins over the converted OA score. */
export function finalScore(oaScore: number | null, refined: number | null | undefined): number | null {
  if (typeof refined === 'number' && Number.isFinite(refined)) return clampScore(Math.round(refined));
  return convertScore(oaScore);
}

export function tierFor(score: number | null): Tier | null {
  if (score === null || !Number.isFinite(score) || score < 1) return null;
  return TIERS.find((t) => score >= t.min) ?? null;
}

export function tierById(id: string): Tier | null {
  return TIERS.find((t) => t.id === id) ?? null;
}

function clampScore(n: number): number {
  return Math.min(100, Math.max(1, n));
}
