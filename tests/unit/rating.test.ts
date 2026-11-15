import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertScore, finalScore, tierById, tierFor, TIERS, TOP_TIER_ID } from '../../src/config/rating';

describe('convertScore', () => {
  it('converts an OA score (1–10) to 1–100', () => {
    expect(convertScore(10)).toBe(100);
    expect(convertScore(7)).toBe(70);
    expect(convertScore(1)).toBe(10);
    expect(convertScore(null)).toBeNull();
  });
});

describe('finalScore', () => {
  it('uses the refined score when set', () => {
    expect(finalScore(9, 92)).toBe(92);
    expect(finalScore(null, 77)).toBe(77);
  });

  it('falls back to the converted OA score', () => {
    expect(finalScore(9, null)).toBe(90);
    expect(finalScore(9, undefined)).toBe(90);
    expect(finalScore(null, null)).toBeNull();
  });

  it('clamps and rounds refined scores to 1–100', () => {
    expect(finalScore(5, 140)).toBe(100);
    expect(finalScore(5, 0)).toBe(1);
    expect(finalScore(5, 87.6)).toBe(88);
  });
});

describe('tierFor', () => {
  it.each([
    [100, 'S+', 'Masterpiece'],
    [95, 'S+', 'Masterpiece'],
    [94, 'S', 'Exceptional'],
    [90, 'S', 'Exceptional'],
    [89, 'A+', 'Excellent'],
    [85, 'A+', 'Excellent'],
    [84, 'A', 'Great'],
    [80, 'A', 'Great'],
    [79, 'B+', 'Very good'],
    [75, 'B+', 'Very good'],
    [74, 'B', 'Good'],
    [70, 'B', 'Good'],
    [69, 'C+', 'Solid'],
    [65, 'C+', 'Solid'],
    [64, 'C', 'Decent'],
    [60, 'C', 'Decent'],
    [59, 'D+', 'Passable'],
    [55, 'D+', 'Passable'],
    [54, 'D', 'Mediocre'],
    [50, 'D', 'Mediocre'],
    [49, 'E', 'Weak'],
    [40, 'E', 'Weak'],
    [39, 'F', 'Bad'],
    [1, 'F', 'Bad'],
  ])('%i → %s · %s', (score, name, label) => {
    const tier = tierFor(score)!;
    expect(tier.name).toBe(name);
    expect(tier.label).toBe(label);
  });

  it('puts every OglądajAnime score from 4 to 10 in its own tier', () => {
    const names = [4, 5, 6, 7, 8, 9, 10].map((s) => tierFor(convertScore(s))!.name);
    expect(names).toEqual(['E', 'D', 'C', 'B', 'A', 'S', 'S+']);
    expect(new Set([1, 2, 3].map((s) => tierFor(convertScore(s))!.name))).toEqual(new Set(['F']));
  });

  it('has no tier for a missing score', () => {
    expect(tierFor(null)).toBeNull();
    expect(tierFor(0)).toBeNull();
  });
});

describe('tier config', () => {
  it('is sorted from the highest threshold to the lowest, with unique ids and names', () => {
    const mins = TIERS.map((t) => t.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
    expect(new Set(TIERS.map((t) => t.id)).size).toBe(TIERS.length);
    expect(new Set(TIERS.map((t) => t.name)).size).toBe(TIERS.length);
    expect(TIERS.at(-1)!.min).toBe(1);
  });

  it('looks tiers up by id and knows the top tier', () => {
    expect(tierById('sp')?.name).toBe('S+');
    expect(tierById('nope')).toBeNull();
    expect(TIERS[0]!.id).toBe(TOP_TIER_ID);
  });
});

// ── Tier colors: computed, not eyeballed ─────────────────────────────────────

const tokens = readFileSync(fileURLToPath(new URL('../../src/styles/tokens.css', import.meta.url)), 'utf8');

type Oklch = [number, number, number];
/** Reads `--name: light-dark(oklch(L C H), oklch(L C H));` from tokens.css. */
function token(name: string): { light: Oklch; dark: Oklch } {
  const m = new RegExp(`--${name}: light-dark\\(oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\), oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)\\);`).exec(tokens);
  if (!m) throw new Error(`token --${name} not found in tokens.css`);
  const n = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return { light: [n[0], n[1], n[2]], dark: [n[3], n[4], n[5]] };
}

/** Relative luminance of an OKLCH color, clipped to the sRGB gamut the way a browser would show it. */
function luminance([L, C, h]: Oklch): number {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  const r = clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function contrast(x: Oklch, y: Oklch): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('tier colors', () => {
  const page = token('bg');

  it.each(TIERS.map((t) => [t.name, t.id] as const))('%s badge text meets WCAG AA in both themes', (_name, id) => {
    const bg = token(`tier-${id}-bg`);
    const fg = token(`tier-${id}-fg`);
    // The badge shows fg-on-bg text, and the tier letter as bg-on-fg: the same pair either way.
    expect(contrast(fg.light, bg.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg.dark, bg.dark)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TIERS.map((t) => [t.name, t.id] as const))('%s chart bar stands out from the page in both themes', (_name, id) => {
    const solid = token(`tier-${id}-solid`);
    expect(contrast(solid.light, page.light)).toBeGreaterThanOrEqual(3);
    expect(contrast(solid.dark, page.dark)).toBeGreaterThanOrEqual(3);
  });

  it('gives neighbouring tiers clearly different hues', () => {
    const hues = TIERS.filter((t) => t.id !== 'f').map((t) => token(`tier-${t.id}-solid`).light[2]);
    for (let i = 1; i < hues.length; i++) expect(Math.abs(hues[i]! - hues[i - 1]!)).toBeGreaterThanOrEqual(20);
  });
});
