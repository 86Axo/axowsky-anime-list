import { isEmptyAnnotation, sanitizeAnnotation } from '../src/lib/annotations';
import type { Annotation, AnnotationMap } from '../src/lib/types';

interface Row {
  key: string;
  refined_score: number | null;
  review: string | null;
  tags: string;
  favorite_character: string | null;
  favorite_character_image: string | null;
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
    updatedAt: row.updated_at,
  });
}

export async function listAnnotations(db: D1Database): Promise<AnnotationMap> {
  const { results } = await db.prepare('SELECT * FROM annotations ORDER BY key').all<Row>();
  const out: AnnotationMap = {};
  for (const row of results) out[row.key] = fromRow(row);
  return out;
}

/** Finds a picture for a character name; injected so tests and offline runs can skip the network. */
export type CharacterLookup = (name: string) => Promise<string | null>;

/**
 * Insert or replace one annotation. An empty annotation deletes the row.
 * The character picture is never taken from the request: it is looked up here
 * (or kept, when the name did not change), so a client cannot plant an image URL.
 */
export async function saveAnnotation(
  db: D1Database,
  key: string,
  input: unknown,
  lookup: CharacterLookup | null = null,
): Promise<Annotation | null> {
  const a = sanitizeAnnotation(input);
  a.favoriteCharacterImage = null;
  if (isEmptyAnnotation(a)) {
    await db.prepare('DELETE FROM annotations WHERE key = ?').bind(key).run();
    return null;
  }
  if (a.favoriteCharacter) {
    const previous = await db
      .prepare('SELECT favorite_character, favorite_character_image FROM annotations WHERE key = ?')
      .bind(key)
      .first<Pick<Row, 'favorite_character' | 'favorite_character_image'>>();
    if (previous?.favorite_character === a.favoriteCharacter && previous.favorite_character_image) {
      a.favoriteCharacterImage = previous.favorite_character_image;
    } else if (lookup) {
      a.favoriteCharacterImage = sanitizeAnnotation({ favoriteCharacterImage: await lookup(a.favoriteCharacter) }).favoriteCharacterImage;
    }
  }
  const updatedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO annotations (key, refined_score, review, tags, favorite_character, favorite_character_image, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (key) DO UPDATE SET
         refined_score = excluded.refined_score,
         review = excluded.review,
         tags = excluded.tags,
         favorite_character = excluded.favorite_character,
         favorite_character_image = excluded.favorite_character_image,
         updated_at = excluded.updated_at`,
    )
    .bind(key, a.refinedScore, a.review, JSON.stringify(a.tags), a.favoriteCharacter, a.favoriteCharacterImage, updatedAt)
    .run();
  return { ...a, updatedAt };
}

export async function deleteAnnotation(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM annotations WHERE key = ?').bind(key).run();
}
