import { describe, expect, it } from 'vitest';
import { aliasesFor, findAnnotation, sanitizeAnnotation, sanitizeAnnotationMap } from '../../src/lib/annotations';
import { annotate, type ListItem } from '../../src/lib/model';
import type { Annotation, AnnotationMap } from '../../src/lib/types';

const note = (extra: Partial<Annotation>): Annotation => ({ ...sanitizeAnnotation({}), ...extra });

const item = (key: string, altKey: string | null, extra: Partial<ListItem> = {}): ListItem => ({
  key,
  altKey,
  title: 'T',
  titleEn: null,
  malId: key.startsWith('mal:') ? Number(key.slice(4)) : null,
  image: null,
  status: 'Completed',
  score: 7,
  watched: 12,
  total: 12,
  type: 'TV',
  added: null,
  genres: [],
  year: null,
  malScore: null,
  studio: null,
  duration: null,
  ...extra,
});

describe('notes survive a change of MAL match', () => {
  // My notes on the title with OA slug "a", saved while it was matched to MAL 100.
  const map: AnnotationMap = { 'mal:100': note({ refinedScore: 87, review: 'Mine.', aliases: ['oa:a'] }) };

  it('are found when a later sync matches the title to a different MAL entry', () => {
    expect(findAnnotation(item('mal:200', 'oa:a'), map)).toEqual({ key: 'mal:100', annotation: map['mal:100'] });
    const [view] = annotate([item('mal:200', 'oa:a')], map);
    expect(view!.final).toBe(87);
    expect(view!.review).toBe('Mine.');
  });

  it('are found when the title loses its MAL match altogether', () => {
    expect(findAnnotation(item('oa:a', null), map)?.key).toBe('mal:100');
  });

  it('are not handed to another title that has taken over the same MAL id', () => {
    expect(findAnnotation(item('mal:100', 'oa:b'), map)).toBeNull();
    expect(annotate([item('mal:100', 'oa:b', { score: 5 })], map)[0]!.final).toBe(50);
  });

  it('still work for older notes saved without aliases', () => {
    const old: AnnotationMap = { 'mal:100': note({ refinedScore: 70 }), 'oa:c': note({ refinedScore: 60 }) };
    expect(findAnnotation(item('mal:100', 'oa:a'), old)?.key).toBe('mal:100');
    expect(findAnnotation(item('mal:300', 'oa:c'), old)?.key).toBe('oa:c');
  });

  it('prefer notes stored under the key itself over notes reached through an alias', () => {
    const both: AnnotationMap = {
      'mal:200': note({ refinedScore: 99, aliases: ['oa:a'] }),
      'mal:100': note({ refinedScore: 87, aliases: ['oa:a'] }),
    };
    expect(findAnnotation(item('mal:200', 'oa:a'), both)?.key).toBe('mal:200');
  });

  it('let two titles that share a MAL id keep separate notes', () => {
    const shared: AnnotationMap = {
      'mal:100': note({ refinedScore: 87, aliases: ['oa:a'] }), // title A, saved first
      'oa:b': note({ refinedScore: 55, aliases: ['mal:100'] }), // title B, saved under its OA key
    };
    expect(findAnnotation(item('oa:a', null), shared)?.key).toBe('mal:100');
    expect(findAnnotation(item('mal:100', 'oa:b'), shared)?.key).toBe('oa:b');
  });
});

describe('aliases', () => {
  it('are the title’s other keys', () => {
    expect(aliasesFor(item('mal:100', 'oa:a'), 'mal:100')).toEqual(['oa:a']);
    expect(aliasesFor(item('mal:100', 'oa:a'), 'oa:a')).toEqual(['mal:100']);
    expect(aliasesFor(item('mal:100', null), 'mal:100')).toEqual([]);
  });

  it('are cleaned: only valid keys, no duplicates, at most six', () => {
    const a = sanitizeAnnotation({ aliases: ['oa:a', 'oa:a', 'bad key', 42, '../x', 'mal:1', 'mal:2', 'mal:3', 'mal:4', 'mal:5', 'mal:6'] });
    expect(a.aliases).toEqual(['oa:a', 'mal:1', 'mal:2', 'mal:3', 'mal:4', 'mal:5']);
    expect(sanitizeAnnotation({}).aliases).toEqual([]);
  });

  it('alone do not keep an empty annotation alive', () => {
    expect(sanitizeAnnotationMap({ 'mal:1': { aliases: ['oa:a'] } })).toEqual({});
  });
});
