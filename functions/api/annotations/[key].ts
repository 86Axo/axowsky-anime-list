import { deleteAnnotation, saveAnnotation, type CharacterLookup } from '../../../server/annotations';
import { json, requireAdmin, type Env } from '../../../server/auth';
import { lookupCharacterImage } from '../../../server/characters';
import { isValidKey } from '../../../src/lib/annotations';

const MAX_BODY_BYTES = 16_384;

function keyParam(params: Record<string, string | string[]>): string | null {
  const raw = params.key;
  const key = typeof raw === 'string' ? decodeURIComponent(raw) : '';
  return isValidKey(key) ? key : null;
}

/** The MAL id an annotation belongs to: from its key, or from the `malId` hint the admin page sends for `oa:` keys. */
function malIdFor(key: string, body: unknown): number | null {
  const fromKey = /^mal:(\d+)$/.exec(key);
  if (fromKey) return Number(fromKey[1]);
  const hint = (body as { malId?: unknown } | null)?.malId;
  return typeof hint === 'number' && Number.isInteger(hint) && hint > 0 ? hint : null;
}

/** Create or replace one annotation. Admin only. */
export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const key = keyParam(params);
  if (!key) return json({ error: 'Invalid annotation key.' }, 400);
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) {
    return json({ error: 'Send JSON.' }, 415);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: 'Body too large.' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Body is not valid JSON.' }, 400);
  }
  const malId = malIdFor(key, body);
  const lookup: CharacterLookup | null =
    malId !== null && env.CHARACTER_LOOKUP !== 'off' ? (name) => lookupCharacterImage(malId, name) : null;
  const saved = await saveAnnotation(env.DB, key, body, lookup);
  return json({ key, annotation: saved });
};

/** Remove one annotation. Admin only. */
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const key = keyParam(params);
  if (!key) return json({ error: 'Invalid annotation key.' }, 400);
  await deleteAnnotation(env.DB, key);
  return json({ key, annotation: null });
};
