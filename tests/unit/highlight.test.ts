import { describe, expect, it } from 'vitest';
import { isEmptyAnnotation, sanitizeAnnotation } from '../../src/lib/annotations';
import { annotate, type ListItem } from '../../src/lib/model';
import { applyState, DEFAULT_STATE } from '../../src/lib/query';
import { renderHeroCovers, renderItem, renderTop, renderWatching, tierBadge } from '../../src/lib/render';
import type { Annotation } from '../../src/lib/types';

const item = (title: string, extra: Partial<ListItem> = {}): ListItem => ({
  key: `oa:${title.toLowerCase()}`,
  altKey: null,
  title,
  titleEn: null,
  malId: null,
  image: null,
  status: 'Completed',
  score: 7,
  watched: 12,
  total: 12,
  type: 'TV',
  added: '2024-03-01T10:00:00',
  genres: [],
  year: 2020,
  malScore: null,
  studio: null,
  duration: 24,
  ...extra,
});

const note = (extra: Partial<Annotation>): Annotation => ({ ...sanitizeAnnotation({}), ...extra });

describe('highlight', () => {
  it('is a plain flag: only `true` switches it on', () => {
    expect(sanitizeAnnotation({ highlight: true }).highlight).toBe(true);
    for (const off of [false, 'yes', 1, null, undefined]) expect(sanitizeAnnotation({ highlight: off }).highlight).toBe(false);
    expect(isEmptyAnnotation(sanitizeAnnotation({ highlight: true }))).toBe(false);
    expect(isEmptyAnnotation(sanitizeAnnotation({ highlight: false }))).toBe(true);
  });

  const view = annotate([item('Mid', { score: 6 }), item('Low', { score: 4 }), item('Best', { score: 10 }), item('Plain', { score: 8 })], {
    'oa:mid': note({ highlight: true }),
    'oa:low': note({ highlight: true }),
  });
  const get = (title: string) => view.find((i) => i.title === title)!;

  it('can be filtered in the list', () => {
    const names = applyState(view, { ...DEFAULT_STATE, tier: 'highlighted' }).map((i) => i.title);
    expect(names).toEqual(['Mid', 'Low']);
  });

  it('marks the card and its badge, and says why with a caption', () => {
    const html = renderItem(get('Mid'));
    expect(html).toContain('<li class="item item--highlight"');
    expect(html).toContain('class="tier tier--highlight" data-tier="c"');
    // The caption sits right after the score badge, so the tint never comes from nowhere.
    expect(html).toContain('</span><span class="mention"><span aria-hidden="true">✧</span>Honorable mention</span></span>');
    const plain = renderItem(get('Plain'));
    expect(plain).not.toContain('highlight');
    expect(plain).not.toContain('Honorable mention');
  });

  it('applies in the Top 10 and on the watching cards too, each with the caption', () => {
    const top = renderTop([get('Mid')]);
    expect(top).toContain('class="top-item top-item--highlight top-item--first"');
    expect(top).toContain('Honorable mention');
    const watching = { ...get('Mid'), status: 'Watching' as const, watched: 3 };
    const card = renderWatching([watching], 1);
    expect(card).toContain('<li class="watch-card watch-card--highlight">');
    expect(card).toContain('Honorable mention');
  });
});

describe('the top tier look', () => {
  // OA 10 → 100 (perfect), a refined 97 (S+ but not perfect), OA 9 → 90 (S).
  const view = annotate([item('Best', { score: 10 }), item('Near', { score: 9 }), item('Great', { score: 9 })], {
    'oa:near': note({ refinedScore: 97 }),
  });
  const get = (title: string) => view.find((i) => i.title === title)!;

  it('gives only S+ the special badge, and only 100 the crown and the "Perfect" label', () => {
    expect(tierBadge(97)).toContain('class="tier tier--top" data-tier="sp"');
    expect(tierBadge(97)).toContain('Masterpiece');
    expect(tierBadge(95)).not.toContain('tier--perfect');
    const perfect = tierBadge(100);
    expect(perfect).toContain('class="tier tier--top tier--perfect" data-tier="sp"');
    expect(perfect).toContain('class="tier__crown"');
    expect(perfect).toContain('<span class="tier__label">Perfect</span>');
    expect(perfect).toContain('title="S+ · 100 · Perfect"');
    expect(perfect).not.toContain('Masterpiece');
    expect(tierBadge(94)).toContain('class="tier" data-tier="s"');
    expect(tierBadge(94)).not.toContain('tier--top');
  });

  it('marks S+ and perfect cards in the list and in the Top 10', () => {
    expect(renderItem(get('Best'))).toContain('<li class="item item--top item--perfect"');
    expect(renderItem(get('Near'))).toContain('<li class="item item--top"');
    expect(renderItem(get('Great'))).toContain('<li class="item"');
    const top = renderTop([get('Best'), get('Near'), get('Great')]);
    expect(top).toContain('class="top-item top-item--top top-item--perfect top-item--first"');
    expect(top).toContain('<li class="top-item top-item--top">');
    expect(top).toContain('<li class="top-item">');
  });

  it('keeps the S+ badge when an S+ title is also highlighted', () => {
    const both = annotate([item('Best', { score: 10 })], { 'oa:best': note({ highlight: true }) })[0]!;
    const html = renderItem(both);
    expect(html).toContain('<li class="item item--top item--perfect item--highlight"');
    expect(html).toContain('class="tier tier--top tier--perfect"');
    expect(html).not.toContain('tier--highlight');
  });
});

describe('header cover backdrop', () => {
  const withCovers = (n: number) =>
    annotate(
      Array.from({ length: n }, (_, i) => item(`T${i}`, { image: `https://cdn.myanimelist.net/images/anime/1/${i}.webp` })),
      {},
    );
  const sources = (html: string) => [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]!);

  it('puts up to ten covers on one track, twice, so the loop has no seam', () => {
    const html = renderHeroCovers(withCovers(12));
    expect(html.startsWith('<div class="hero__track">')).toBe(true);
    const src = sources(html);
    // 10 covers repeated to at least 12 per run, and the run appears twice.
    expect(src).toHaveLength(40);
    expect(new Set(src).size).toBe(10);
    expect(src.slice(0, 20)).toEqual(src.slice(20));
  });

  it('repeats a short Top 10 so a run is still wider than the screen', () => {
    const src = sources(renderHeroCovers(withCovers(3)));
    expect(src.length / 2).toBeGreaterThanOrEqual(12);
    expect(src.slice(0, src.length / 2)).toEqual(src.slice(src.length / 2));
  });

  it('is decoration only: no alt text, no links, loaded lazily', () => {
    const html = renderHeroCovers(withCovers(4));
    expect(html).not.toContain('<a ');
    expect(html.match(/alt=""/g)).toHaveLength(html.match(/<img /g)!.length);
    expect(html.match(/loading="lazy"/g)).toHaveLength(html.match(/<img /g)!.length);
  });

  it('renders nothing when no title has a cover', () => {
    expect(renderHeroCovers(annotate([item('No cover')], {}))).toBe('');
  });
});
