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

// Twelve tiers in steps of five from 50 up. I rate strictly, so the middle of the scale
// (50–70) is where most titles land and needs the finest distinctions.
// An OglądajAnime score lands on the lower half of a letter (8/10 → 80 → A); the "+" tiers
// are reached with a refined score (86 → A+).
export const TIERS: readonly Tier[] = [
  { id: 'sp', name: 'S+', min: 95, label: 'Masterpiece' },
  { id: 's', name: 'S', min: 90, label: 'Exceptional' },
  { id: 'ap', name: 'A+', min: 85, label: 'Excellent' },
  { id: 'a', name: 'A', min: 80, label: 'Great' },
  { id: 'bp', name: 'B+', min: 75, label: 'Very good' },
  { id: 'b', name: 'B', min: 70, label: 'Good' },
  { id: 'cp', name: 'C+', min: 65, label: 'Solid' },
  { id: 'c', name: 'C', min: 60, label: 'Decent' },
  { id: 'dp', name: 'D+', min: 55, label: 'Passable' },
  { id: 'd', name: 'D', min: 50, label: 'Mediocre' },
  { id: 'e', name: 'E', min: 40, label: 'Weak' },
  { id: 'f', name: 'F', min: 1, label: 'Bad' },
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
