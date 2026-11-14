import { SITE } from '../config/site';
import { sanitizeAnnotationMap } from './annotations';
import type { AnnotationMap } from './types';

/**
 * Annotations as they are at build time, read from the live read-only API.
 * Baking them in means the first paint already shows refined scores and notes;
 * the browser then re-checks the API and patches anything newer.
 * Any failure (first deploy, offline build) just means "no annotations yet".
 */
export async function loadBakedAnnotations(): Promise<AnnotationMap> {
  if (import.meta.env.DEV || process.env.BAKE_ANNOTATIONS === '0') return {};
  try {
    const res = await fetch(new URL('/api/annotations', SITE.url), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return {};
    const body = (await res.json()) as { annotations?: unknown };
    return sanitizeAnnotationMap(body.annotations);
  } catch {
    return {};
  }
}
