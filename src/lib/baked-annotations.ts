import { SITE } from '../config/site';
import { sanitizeAnnotationMap } from './annotations';
import { sanitizeEntries, type ManualEntry } from './entries';
import type { AnnotationMap } from './types';

/** GET a JSON field from the live read-only API, or undefined on any failure. */
async function fromLiveApi(path: string, field: string): Promise<unknown> {
  if (import.meta.env.DEV || process.env.BAKE_ANNOTATIONS === '0') return undefined;
  try {
    const res = await fetch(new URL(path, SITE.url), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    return ((await res.json()) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/**
 * Annotations as they are at build time, read from the live read-only API.
 * Baking them in means the first paint already shows refined scores and notes;
 * the browser then re-checks the API and patches anything newer.
 * Any failure (first deploy, offline build) just means "no annotations yet".
 */
export async function loadBakedAnnotations(): Promise<AnnotationMap> {
  return sanitizeAnnotationMap(await fromLiveApi('/api/annotations', 'annotations'));
}

/** Titles I added by hand, as they are at build time. Same rules as the annotations. */
export async function loadBakedEntries(): Promise<ManualEntry[]> {
  return sanitizeEntries(await fromLiveApi('/api/entries', 'entries'));
}
