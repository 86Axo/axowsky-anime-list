import { json, requireAdmin, type Env } from '../../../server/auth';
import { deleteEntry, saveEntry } from '../../../server/entries';

const MAX_BODY_BYTES = 16_384;

function malIdParam(params: Record<string, string | string[]>): number | null {
  const raw = params.malId;
  const n = typeof raw === 'string' && /^\d{1,8}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Add or update a title I added by hand. Admin only. */
export const onRequestPut: PagesFunction<Env> = async ({ request, env, params }) => {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const malId = malIdParam(params);
  if (malId === null) return json({ error: 'Invalid MAL id.' }, 400);
  if (!(request.headers.get('Content-Type') ?? '').includes('application/json')) return json({ error: 'Send JSON.' }, 415);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: 'Body too large.' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Body is not valid JSON.' }, 400);
  }
  const entry = await saveEntry(env.DB, malId, body);
  if (!entry) return json({ error: 'A title is required.' }, 400);
  return json({ entry });
};

/** Remove a title I added by hand. My notes on it are kept. Admin only. */
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const malId = malIdParam(params);
  if (malId === null) return json({ error: 'Invalid MAL id.' }, 400);
  await deleteEntry(env.DB, malId);
  return json({ malId, entry: null });
};
