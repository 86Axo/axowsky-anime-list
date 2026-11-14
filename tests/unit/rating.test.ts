import { describe, expect, it } from 'vitest';
import { convertScore, finalScore, tierById, tierFor, TIERS } from '../../src/config/rating';

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
    [92, 'S', 'Exceptional'],
    [90, 'S', 'Exceptional'],
    [89, 'A', 'Great'],
    [80, 'A', 'Great'],
    [79, 'B', 'Good'],
    [70, 'B', 'Good'],
    [69, 'C', 'Decent'],
    [60, 'C', 'Decent'],
    [59, 'D', 'Mediocre'],
    [50, 'D', 'Mediocre'],
    [49, 'F', 'Bad'],
    [1, 'F', 'Bad'],
  ])('%i → %s · %s', (score, name, label) => {
    const tier = tierFor(score)!;
    expect(tier.name).toBe(name);
    expect(tier.label).toBe(label);
  });

  it('has no tier for a missing score', () => {
    expect(tierFor(null)).toBeNull();
    expect(tierFor(0)).toBeNull();
  });
});

describe('tier config', () => {
  it('is sorted from the highest threshold to the lowest, with unique ids', () => {
    const mins = TIERS.map((t) => t.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
    expect(new Set(TIERS.map((t) => t.id)).size).toBe(TIERS.length);
    expect(TIERS.at(-1)!.min).toBe(1);
  });

  it('looks tiers up by id', () => {
    expect(tierById('sp')?.name).toBe('S+');
    expect(tierById('nope')).toBeNull();
  });
});
