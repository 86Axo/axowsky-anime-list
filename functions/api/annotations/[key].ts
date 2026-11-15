import { deleteAnnotation, saveAnnotation } from '../../../server/annotations';
import { json, requireAdmin, type Env } from '../../../server/auth';
import { isValidKey } from '../../../src/lib/annotations';

const MAX_BODY_BYTES = 16_384;

function keyParam(params: Record<string, string | string[]>): string | null {
  const raw = params.key;
  const key = typeof raw === 'string' ? decodeURIComponent(raw) : '';
  return isValidKey(key) ? key : null;
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
  const saved = await saveAnnotation(env.DB, key, body);
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
