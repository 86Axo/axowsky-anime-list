import { listAnnotations } from '../../../server/annotations';
import { json, type Env } from '../../../server/auth';

/** Public, read-only: every annotation, keyed by `mal:<id>` / `oa:<slug>`. */
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const annotations = await listAnnotations(env.DB);
  return json({ annotations }, 200, { 'Cache-Control': 'public, max-age=30' });
};
