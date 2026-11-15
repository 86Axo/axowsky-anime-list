import type { Annotation, AnnotationMap } from './types';

export const LIMITS = { review: 2000, tag: 32, tags: 12, favoriteCharacter: 80, key: 200, topOrder: 999, distinction: 40 } as const;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim().slice(0, max);
  return t === '' ? null : t;
};

/** Hosts a character picture may come from. They match the page's Content-Security-Policy. */
const IMAGE_HOSTS = ['s4.anilist.co', 'cdn.myanimelist.net'];

/** An https URL on an allowed image host, or null. */
function imageUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Coerce untrusted input (an API body or an API response) into a valid annotation.
 * Used by the write API, the build and the browser, so all three accept exactly the same shape.
 */
export function sanitizeAnnotation(raw: unknown): Annotation {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const score = typeof r.refinedScore === 'number' && Number.isFinite(r.refinedScore) ? Math.round(r.refinedScore) : null;
  const tags = Array.isArray(r.tags)
    ? [...new Set(r.tags.map((t) => text(t, LIMITS.tag)).filter((t): t is string => t !== null))].slice(0, LIMITS.tags)
    : [];
  const favoriteCharacter = text(r.favoriteCharacter, LIMITS.favoriteCharacter);
  const out: Annotation = {
    refinedScore: score !== null && score >= 1 && score <= 100 ? score : null,
    review: text(r.review, LIMITS.review),
    tags,
    favoriteCharacter,
    // A picture only makes sense next to a name.
    favoriteCharacterImage: favoriteCharacter ? imageUrl(r.favoriteCharacterImage) : null,
    topOrder:
      typeof r.topOrder === 'number' && Number.isInteger(r.topOrder) && r.topOrder >= 1 && r.topOrder <= LIMITS.topOrder
        ? r.topOrder
        : null,
    distinction: text(r.distinction, LIMITS.distinction),
  };
  if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt;
  return out;
}

export const isEmptyAnnotation = (a: Annotation): boolean =>
  a.refinedScore === null && a.review === null && a.tags.length === 0 && a.favoriteCharacter === null && a.topOrder === null && a.distinction === null;

export function sanitizeAnnotationMap(raw: unknown): AnnotationMap {
  const out: AnnotationMap = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidKey(key)) continue;
    const a = sanitizeAnnotation(value);
    if (!isEmptyAnnotation(a)) out[key] = a;
  }
  return out;
}

/** Annotation keys look like `mal:123`, `oa:some-slug` or `title:some-title`. */
export const isValidKey = (key: string): boolean => key.length <= LIMITS.key && /^(mal:\d+|(oa|title):[^\s/?#]+)$/.test(key);

/** Order-independent fingerprint of everything that affects rendering. */
export function annotationsFingerprint(map: AnnotationMap): string {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((k) => [k, map[k]!.refinedScore, map[k]!.review, map[k]!.tags, map[k]!.favoriteCharacter, map[k]!.favoriteCharacterImage, map[k]!.topOrder, map[k]!.distinction]),
  );
}
