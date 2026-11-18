import { isEmptyAnnotation, LIMITS, sanitizeAnnotation } from '../src/lib/annotations';
import type { Annotation, AnnotationMap } from '../src/lib/types';

interface Row {
  key: string;
  refined_score: number | null;
  review: string | null;
  tags: string;
  favorite_character: string | null;
  favorite_character_image: string | null;
  top_order: number | null;
  /** The highlight flag. The column keeps its first name; any non-empty value means "highlighted". */
  distinction: string | null;
  /** JSON array of the title's other keys. */
  aliases: string | null;
  updated_at: string;
}

const parseList = (cell: string | null): unknown => {
  if (!cell) return [];
  try {
    return JSON.parse(cell);
  } catch {
    return []; // a corrupt cell reads as "none"
  }
};

function fromRow(row: Row): Annotation {
  return sanitizeAnnotation({
    refinedScore: row.refined_score,
    review: row.review,
    tags: parseList(row.tags),
    favoriteCharacter: row.favorite_character,
    favoriteCharacterImage: row.favorite_character_image,
    topOrder: row.top_order,
    highlight: row.distinction !== null && row.distinction !== '',
    aliases: parseList(row.aliases),
    updatedAt: row.updated_at,
  });
}

export async function listAnnotations(db: D1Database): Promise<AnnotationMap> {
  const { results } = await db.prepare('SELECT * FROM annotations ORDER BY key').all<Row>();
  const out: AnnotationMap = {};
  for (const row of results) out[row.key] = fromRow(row);
  return out;
}

/** The notes under this key belong to a different title. */
export class AnnotationConflictError extends Error {}

/**
 * Insert or replace one annotation. An empty annotation deletes the row.
 *
 * Two guards keep my notes from being lost:
 * - A save is refused when the row under this key belongs to a different OglądajAnime
 *   title (its aliases name another `oa:` slug). That can only happen after a sync has
 *   matched a second title to the same MAL id; the admin panel then saves elsewhere.
 * - Aliases are only ever added, never dropped, so a title can always be found again.
 *
 * The character picture comes from the admin panel (it looks the character up on AniList
 * in the browser). sanitizeAnnotation only lets through https URLs on the known image hosts.
 * When a save carries no picture and the name did not change, the stored picture is kept.
 */
export async function saveAnnotation(db: D1Database, key: string, input: unknown): Promise<Annotation | null> {
  const a = sanitizeAnnotation(input);
  const previous = await db
    .prepare('SELECT favorite_character, favorite_character_image, aliases FROM annotations WHERE key = ?')
    .bind(key)
    .first<Pick<Row, 'favorite_character' | 'favorite_character_image' | 'aliases'>>();

  if (previous) {
    const before = sanitizeAnnotation({ aliases: parseList(previous.aliases) }).aliases;
    const theirOa = [key, ...before].filter((k) => k.startsWith('oa:'));
    const ourOa = [key, ...a.aliases].filter((k) => k.startsWith('oa:'));
    if (theirOa.length > 0 && ourOa.length > 0 && !ourOa.some((k) => theirOa.includes(k))) {
      throw new AnnotationConflictError(`The notes under ${key} belong to another title.`);
    }
    a.aliases = [...new Set([...before, ...a.aliases])].filter((k) => k !== key).slice(0, LIMITS.aliases);
  } else {
    a.aliases = a.aliases.filter((k) => k !== key);
  }

  if (isEmptyAnnotation(a)) {
    await db.prepare('DELETE FROM annotations WHERE key = ?').bind(key).run();
    return null;
  }
  if (a.favoriteCharacter && !a.favoriteCharacterImage) {
    if (previous?.favorite_character === a.favoriteCharacter && previous.favorite_character_image) {
      a.favoriteCharacterImage = previous.favorite_character_image;
    }
  }
  const updatedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO annotations (key, refined_score, review, tags, favorite_character, favorite_character_image, top_order, distinction, aliases, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT (key) DO UPDATE SET
         refined_score = excluded.refined_score,
         review = excluded.review,
         tags = excluded.tags,
         favorite_character = excluded.favorite_character,
         favorite_character_image = excluded.favorite_character_image,
         top_order = excluded.top_order,
         distinction = excluded.distinction,
         aliases = excluded.aliases,
         updated_at = excluded.updated_at`,
    )
    .bind(
      key,
      a.refinedScore,
      a.review,
      JSON.stringify(a.tags),
      a.favoriteCharacter,
      a.favoriteCharacterImage,
      a.topOrder,
      a.highlight ? '1' : null,
      a.aliases.length > 0 ? JSON.stringify(a.aliases) : null,
      updatedAt,
    )
    .run();
  return { ...a, updatedAt };
}

export async function deleteAnnotation(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM annotations WHERE key = ?').bind(key).run();
}
