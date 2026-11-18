import type { Annotation, AnnotationMap } from './types';

export const LIMITS = { review: 2000, tag: 32, tags: 12, favoriteCharacter: 80, key: 200, topOrder: 999, aliases: 6 } as const;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n/g, '\n').trim().slice(0, max);
  return t === '' ? null : t;
};

/** Hosts a picture may come from. They match the page's Content-Security-Policy. */
const IMAGE_HOSTS = ['s4.anilist.co', 'cdn.myanimelist.net'];

/** An https URL on an allowed image host, or null. */
export function imageUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && IMAGE_HOSTS.includes(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/** Annotation keys look like `mal:123`, `oa:some-slug` or `title:some-title`. */
export const isValidKey = (key: string): boolean => key.length <= LIMITS.key && /^(mal:\d+|(oa|title):[^\s/?#]+)$/.test(key);

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
  const aliases = Array.isArray(r.aliases)
    ? [...new Set(r.aliases.filter((k): k is string => typeof k === 'string' && isValidKey(k)))].slice(0, LIMITS.aliases)
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
    highlight: r.highlight === true,
    aliases,
  };
  if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt;
  return out;
}

/** Nothing worth keeping. Aliases alone are bookkeeping, not content. */
export const isEmptyAnnotation = (a: Annotation): boolean =>
  a.refinedScore === null && a.review === null && a.tags.length === 0 && a.favoriteCharacter === null && a.topOrder === null && !a.highlight;

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

/** Order-independent fingerprint of everything that affects rendering. */
export function annotationsFingerprint(map: AnnotationMap): string {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((k) => {
        const a = map[k]!;
        return [k, a.refinedScore, a.review, a.tags, a.favoriteCharacter, a.favoriteCharacterImage, a.topOrder, a.highlight, a.aliases];
      }),
  );
}

// ── Finding the notes of a title ─────────────────────────────────────────────
//
// Notes are stored under the title's main key (normally `mal:<id>`) and list the
// title's other keys as aliases (its `oa:<slug>`). The OA slug never changes while
// the title is on my list, so if a later sync matches the title to a different MAL
// entry, the notes are still found through the alias instead of being orphaned.

/** The keys a list row is known by. */
export interface KeyedItem {
  key: string;
  altKey: string | null;
}

/** Stored keys and aliases → the stored keys of the annotations they lead to. Direct keys come first. */
export type AnnotationIndex = Map<string, string[]>;

export function indexAnnotations(map: AnnotationMap): AnnotationIndex {
  const index: AnnotationIndex = new Map();
  const add = (k: string, stored: string) => index.set(k, [...(index.get(k) ?? []), stored]);
  for (const stored of Object.keys(map)) add(stored, stored);
  for (const [stored, a] of Object.entries(map)) for (const alias of a.aliases) if (alias !== stored) add(alias, stored);
  return index;
}

const oaKeyOf = (item: KeyedItem): string | null =>
  item.key.startsWith('oa:') ? item.key : item.altKey?.startsWith('oa:') ? item.altKey : null;

/**
 * The notes that belong to a title, and the key they are stored under.
 * Notes reached through a key are rejected when they name a different OA title:
 * that happens if another row has since taken over this row's MAL id.
 */
export function findAnnotation(
  item: KeyedItem,
  map: AnnotationMap,
  index: AnnotationIndex = indexAnnotations(map),
): { key: string; annotation: Annotation } | null {
  const ownOa = oaKeyOf(item);
  for (const k of [item.key, item.altKey]) {
    if (!k) continue;
    for (const stored of index.get(k) ?? []) {
      const a = map[stored]!;
      const theirOa = [stored, ...a.aliases].filter((x) => x.startsWith('oa:'));
      if (ownOa && theirOa.length > 0 && !theirOa.includes(ownOa)) continue;
      return { key: stored, annotation: a };
    }
  }
  return null;
}

/** The aliases to store with a title's notes when they are saved under `storedKey`. */
export const aliasesFor = (item: KeyedItem, storedKey: string): string[] =>
  [item.key, item.altKey].filter((k): k is string => k !== null && k !== storedKey);
