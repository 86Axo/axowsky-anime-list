import { json, type Env } from '../../../server/auth';
import { listEntries } from '../../../server/entries';

/** Public, read-only: the titles I added by hand. */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const entries = await listEntries(env.DB);
  return json({ entries }, 200, { 'Cache-Control': 'public, max-age=30' });
};
