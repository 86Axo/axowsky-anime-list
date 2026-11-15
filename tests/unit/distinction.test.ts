import { describe, expect, it } from 'vitest';
import { isEmptyAnnotation, sanitizeAnnotation } from '../../src/lib/annotations';
import { annotate, honored, type ListItem } from '../../src/lib/model';
import { applyState, DEFAULT_STATE } from '../../src/lib/query';
import { renderHonors, renderItem, renderTop, tierBadge } from '../../src/lib/render';
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

describe('distinction', () => {
  it('is a short label; an empty one means no distinction', () => {
    expect(sanitizeAnnotation({ distinction: '  Best soundtrack ' }).distinction).toBe('Best soundtrack');
    expect(sanitizeAnnotation({ distinction: '   ' }).distinction).toBeNull();
    expect(sanitizeAnnotation({ distinction: 7 }).distinction).toBeNull();
    expect(sanitizeAnnotation({ distinction: 'x'.repeat(100) }).distinction).toHaveLength(40);
    expect(isEmptyAnnotation(sanitizeAnnotation({ distinction: 'Honorable mention' }))).toBe(false);
  });

  const view = annotate([item('Mid', { score: 6 }), item('Low', { score: 4 }), item('Best', { score: 10 }), item('Plain', { score: 8 })], {
    'oa:mid': note({ distinction: 'Best soundtrack' }),
    'oa:low': note({ distinction: 'Honorable mention' }),
  });

  it('lists the titles I singled out, best score first, whatever their tier', () => {
    expect(honored(view).map((i) => i.title)).toEqual(['Mid', 'Low']);
    expect(honored(annotate([item('A')], {}))).toEqual([]);
  });

  it('can be filtered in the list', () => {
    const names = applyState(view, { ...DEFAULT_STATE, tier: 'honored' }).map((i) => i.title);
    expect(names).toEqual(['Mid', 'Low']);
  });

  it('shows a star chip with the label and marks the card', () => {
    const html = renderItem(view.find((i) => i.title === 'Mid')!);
    expect(html).toContain('<li class="item item--honored"');
    expect(html).toContain('class="honor"');
    expect(html).toContain('<span class="vh">Distinction: </span>Best soundtrack</span>');
    expect(renderItem(view.find((i) => i.title === 'Plain')!)).not.toContain('honor');
  });

  it('gets its own section with the chip, the score and a MAL button per title', () => {
    const html = renderHonors(honored(view));
    expect(html.match(/<li class="honor-item">/g)).toHaveLength(2);
    expect(html).toContain('Best soundtrack');
    expect(html.match(/class="mal-link"/g)).toHaveLength(2);
    expect(renderHonors([])).toBe('');
  });

  it('escapes the label', () => {
    const evil = annotate([item('X')], { 'oa:x': note({ distinction: '<b>bold</b>' }) })[0]!;
    expect(renderItem(evil)).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(renderItem(evil)).not.toContain('<b>bold</b>');
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

  it('can carry both marks at once', () => {
    const both = annotate([item('Best', { score: 10 })], { 'oa:best': note({ distinction: 'Personal favorite' }) })[0]!;
    expect(renderItem(both)).toContain('<li class="item item--top item--honored"');
  });
});
