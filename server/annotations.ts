import { isEmptyAnnotation, sanitizeAnnotation } from '../src/lib/annotations';
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
  updated_at: string;
}

function fromRow(row: Row): Annotation {
  let tags: unknown = [];
  try {
    tags = JSON.parse(row.tags);
  } catch {
    /* a corrupt tags cell reads as "no tags" */
  }
  return sanitizeAnnotation({
    refinedScore: row.refined_score,
    review: row.review,
    tags,
    favoriteCharacter: row.favorite_character,
    favoriteCharacterImage: row.favorite_character_image,
    topOrder: row.top_order,
    highlight: row.distinction !== null && row.distinction !== '',
    updatedAt: row.updated_at,
  });
}

export async function listAnnotations(db: D1Database): Promise<AnnotationMap> {
  const { results } = await db.prepare('SELECT * FROM annotations ORDER BY key').all<Row>();
  const out: AnnotationMap = {};
  for (const row of results) out[row.key] = fromRow(row);
  return out;
}

/**
 * Insert or replace one annotation. An empty annotation deletes the row.
 * The character picture comes from the admin panel (it looks the character up on AniList
 * in the browser). sanitizeAnnotation only lets through https URLs on the known image hosts.
 * When a save carries no picture and the name did not change, the stored picture is kept.
 */
export async function saveAnnotation(db: D1Database, key: string, input: unknown): Promise<Annotation | null> {
  const a = sanitizeAnnotation(input);
  if (isEmptyAnnotation(a)) {
    await db.prepare('DELETE FROM annotations WHERE key = ?').bind(key).run();
    return null;
  }
  if (a.favoriteCharacter && !a.favoriteCharacterImage) {
    const previous = await db
      .prepare('SELECT favorite_character, favorite_character_image FROM annotations WHERE key = ?')
      .bind(key)
      .first<Pick<Row, 'favorite_character' | 'favorite_character_image'>>();
    if (previous?.favorite_character === a.favoriteCharacter && previous.favorite_character_image) {
      a.favoriteCharacterImage = previous.favorite_character_image;
    }
  }
  const updatedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO annotations (key, refined_score, review, tags, favorite_character, favorite_character_image, top_order, distinction, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT (key) DO UPDATE SET
         refined_score = excluded.refined_score,
         review = excluded.review,
         tags = excluded.tags,
         favorite_character = excluded.favorite_character,
         favorite_character_image = excluded.favorite_character_image,
         top_order = excluded.top_order,
         distinction = excluded.distinction,
         updated_at = excluded.updated_at`,
    )
    .bind(key, a.refinedScore, a.review, JSON.stringify(a.tags), a.favoriteCharacter, a.favoriteCharacterImage, a.topOrder, a.highlight ? '1' : null, updatedAt)
    .run();
  return { ...a, updatedAt };
}

export async function deleteAnnotation(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM annotations WHERE key = ?').bind(key).run();
}
