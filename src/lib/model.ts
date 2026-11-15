import { finalScore, tierFor, TIERS } from '../config/rating';
import { STATUSES, type AnimeEntry, type AnimeType, type Annotation, type AnnotationMap, type Status } from './types';

/** What the page needs per entry. Built at build time and embedded as JSON for the client. */
export interface ListItem {
  key: string;
  /** Second annotation key (`oa:<slug>`), so notes survive a change of MAL match. */
  altKey: string | null;
  title: string;
  titleEn: string | null;
  /** MAL id; null when the title has no MAL match yet. */
  malId: number | null;
  /** ~225px wide cover (WebP). */
  image: string | null;
  status: Status;
  score: number | null;
  watched: number;
  total: number | null;
  type: AnimeType;
  added: string | null;
  genres: string[];
  year: number | null;
  malScore: number | null;
  studio: string | null;
  /** Minutes per episode (or for the whole film). */
  duration: number | null;
}

/** A list item with my annotations and the final score applied. */
export interface ViewItem extends ListItem {
  final: number | null;
  tierId: string | null;
  tags: string[];
  review: string | null;
  favoriteCharacter: string | null;
  favoriteCharacterImage: string | null;
  /** Manual position among titles with the same final score (lower first); null = automatic. */
  topOrder: number | null;
}

const sameTitle = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

export function toListItems(entries: AnimeEntry[]): ListItem[] {
  return entries.map((e) => {
    const mal = e.mal;
    const english = mal?.titleEnglish && !sameTitle(mal.titleEnglish, e.title) ? mal.titleEnglish : null;
    return {
      key: e.key,
      altKey: e.slug && e.key !== `oa:${e.slug}` ? `oa:${e.slug}` : null,
      title: e.title,
      titleEn: english,
      malId: mal?.id ?? null,
      image: mal?.image ?? null,
      status: e.status,
      score: e.score,
      watched: e.watched,
      total: e.total ?? mal?.episodes ?? null,
      type: e.type,
      added: e.addedAt,
      genres: mal?.genres ?? [],
      year: mal?.year ?? null,
      malScore: mal?.score ?? null,
      studio: mal?.studios[0] ?? null,
      duration: mal?.durationMin ?? null,
    };
  });
}

export function annotationFor(item: Pick<ListItem, 'key' | 'altKey'>, annotations: AnnotationMap): Annotation | undefined {
  return annotations[item.key] ?? (item.altKey ? annotations[item.altKey] : undefined);
}

export function annotate(items: ListItem[], annotations: AnnotationMap): ViewItem[] {
  return items.map((item) => {
    const a = annotationFor(item, annotations);
    const final = finalScore(item.score, a?.refinedScore);
    return {
      ...item,
      final,
      tierId: tierFor(final)?.id ?? null,
      tags: a?.tags ?? [],
      review: a?.review || null,
      favoriteCharacter: a?.favoriteCharacter || null,
      favoriteCharacterImage: (a?.favoriteCharacter && a.favoriteCharacterImage) || null,
      topOrder: a?.topOrder ?? null,
    };
  });
}

/**
 * A score on something I have not started is a hope, not a rating: it is shown in
 * the list but left out of the Top 10, the mean score and the tier chart.
 */
export const isRated = (i: ViewItem): boolean => i.final !== null && i.status !== 'Plan to Watch';

export interface Stats {
  total: number;
  completed: number;
  episodes: number;
  hours: number | null;
  meanScore: number | null;
  rated: number;
  topGenre: { name: string; count: number } | null;
}

export function computeStats(items: ViewItem[]): Stats {
  const rated = items.filter(isRated);
  let minutes = 0;
  let timed = 0;
  for (const i of items) {
    if (i.duration !== null && i.watched > 0) {
      minutes += i.watched * i.duration;
      timed++;
    }
  }
  const genres = genreCounts(items);
  return {
    total: items.length,
    completed: items.filter((i) => i.status === 'Completed').length,
    episodes: items.reduce((sum, i) => sum + i.watched, 0),
    hours: timed > 0 ? Math.round(minutes / 60) : null,
    meanScore: rated.length ? rated.reduce((sum, i) => sum + i.final!, 0) / rated.length : null,
    rated: rated.length,
    topGenre: genres[0] ?? null,
  };
}

const byCountThenName = (a: { name: string; count: number }, b: { name: string; count: number }): number =>
  b.count - a.count || a.name.localeCompare(b.name);

function tally(values: Iterable<string>): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count })).sort(byCountThenName);
}

/** Genres of everything I have at least started, most common first. */
export function genreCounts(items: ViewItem[]): { name: string; count: number }[] {
  return tally(items.filter((i) => i.status !== 'Plan to Watch').flatMap((i) => i.genres));
}

export function typeCounts(items: ViewItem[]): { name: string; count: number }[] {
  return tally(items.map((i) => i.type));
}

export function statusCounts(items: ViewItem[]): Record<Status, number> {
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const i of items) out[i.status]++;
  return out;
}

/** Rated titles per tier, in tier order (S+ first), including empty tiers. */
export function tierCounts(items: ViewItem[]): { id: string; name: string; label: string; count: number }[] {
  const rated = items.filter(isRated);
  return TIERS.map((t) => ({ id: t.id, name: t.name, label: t.label, count: rated.filter((i) => i.tierId === t.id).length }));
}

const cmpAddedDesc = (a: ViewItem, b: ViewItem): number => (b.added ?? '').localeCompare(a.added ?? '');

/**
 * Rated titles, best first. Within one final score the manual order decides (titles I placed
 * by hand come first, in that order), then the most recently added, then the title.
 */
export function rankRated(items: ViewItem[]): ViewItem[] {
  return items
    .filter(isRated)
    .sort(
      (a, b) =>
        b.final! - a.final! ||
        (a.topOrder ?? Infinity) - (b.topOrder ?? Infinity) ||
        cmpAddedDesc(a, b) ||
        a.title.localeCompare(b.title),
    );
}

export const topRated = (items: ViewItem[], n = 10): ViewItem[] => rankRated(items).slice(0, n);

/** Shows I am part-way through, most recently added first. */
export function inProgress(items: ViewItem[], n = 18): { shown: ViewItem[]; totalWatching: number } {
  const watching = items.filter((i) => i.status === 'Watching');
  const partial = watching.filter((i) => i.watched > 0 && (i.total === null || i.watched < i.total));
  return { shown: partial.sort((a, b) => cmpAddedDesc(a, b) || a.title.localeCompare(b.title)).slice(0, n), totalWatching: watching.length };
}

export interface Activity {
  /** One entry per calendar month from the first to the last month with data. */
  months: { month: string; count: number }[];
  /** Titles added on a single bulk-import day, left out of `months` so they do not flatten the chart. */
  bulk: { date: string; count: number } | null;
}

/**
 * "Added to list per month". A bulk import (one day with a very large number of
 * additions, such as the day the list was first filled in) is reported separately.
 */
export function activityByMonth(items: ViewItem[], bulkThreshold = 50): Activity {
  const perDay = new Map<string, number>();
  for (const i of items) if (i.added) perDay.set(i.added.slice(0, 10), (perDay.get(i.added.slice(0, 10)) ?? 0) + 1);
  const biggest = [...perDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const bulk = biggest && biggest[1] >= bulkThreshold ? { date: biggest[0], count: biggest[1] } : null;

  const perMonth = new Map<string, number>();
  for (const i of items) {
    if (!i.added || (bulk && i.added.startsWith(bulk.date))) continue;
    const m = i.added.slice(0, 7);
    perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
  }
  const keys = [...perMonth.keys()].sort();
  const months: Activity['months'] = [];
  if (keys.length > 0) {
    let [y, m] = keys[0]!.split('-').map(Number) as [number, number];
    const last = keys.at(-1)!;
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      months.push({ month: key, count: perMonth.get(key) ?? 0 });
      if (key >= last) break;
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
  }
  return { months, bulk };
}
