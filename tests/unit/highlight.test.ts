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

  it('marks the card and its badge, without adding any caption', () => {
    const html = renderItem(get('Mid'));
    expect(html).toContain('<li class="item item--highlight"');
    expect(html).toContain('class="tier tier--highlight" data-tier="c"');
    // Same text as an ordinary row: the highlight is a look, not a label.
    const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text(html)).toBe(text(renderItem({ ...get('Mid'), highlight: false })));
    expect(renderItem(get('Plain'))).not.toContain('highlight');
  });

  it('applies in the Top 10 and on the watching cards too', () => {
    expect(renderTop([get('Mid')])).toContain('class="top-item top-item--highlight top-item--first"');
    const watching = { ...get('Mid'), status: 'Watching' as const, watched: 3 };
    expect(renderWatching([watching], 1)).toContain('<li class="watch-card watch-card--highlight">');
  });
});

describe('the top tier look', () => {
  const view = annotate([item('Best', { score: 10 }), item('Great', { score: 9 })], {});

  it('gives only S+ the special badge', () => {
    expect(tierBadge(100)).toContain('class="tier tier--top" data-tier="sp"');
    expect(tierBadge(95)).toContain('tier--top');
    expect(tierBadge(94)).toContain('class="tier" data-tier="s"');
    expect(tierBadge(94)).not.toContain('tier--top');
  });

  it('marks S+ cards in the list and in the Top 10', () => {
    expect(renderItem(view[0]!)).toContain('<li class="item item--top"');
    expect(renderItem(view[1]!)).toContain('<li class="item"');
    const top = renderTop(view);
    expect(top).toContain('class="top-item top-item--top top-item--first"');
    expect(top).toContain('<li class="top-item">');
  });

  it('keeps the S+ badge when an S+ title is also highlighted', () => {
    const both = annotate([item('Best', { score: 10 })], { 'oa:best': note({ highlight: true }) })[0]!;
    const html = renderItem(both);
    expect(html).toContain('<li class="item item--top item--highlight"');
    expect(html).toContain('class="tier tier--top"');
    expect(html).not.toContain('tier--highlight');
  });
});

describe('header cover strip', () => {
  it('shows up to six covers of the best titles, as decoration only', () => {
    const many = annotate(
      Array.from({ length: 8 }, (_, i) => item(`T${i}`, { image: `https://cdn.myanimelist.net/images/anime/1/${i}.webp` })),
      {},
    );
    const html = renderHeroCovers(many);
    expect(html.match(/<img /g)).toHaveLength(6);
    expect(html).toContain('alt=""');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('<a ');
  });

  it('skips titles without a cover', () => {
    expect(renderHeroCovers(annotate([item('No cover')], {}))).toBe('');
  });
});
