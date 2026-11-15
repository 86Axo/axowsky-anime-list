import { authenticate, json, type Env } from '../../../server/auth';
import { fetchCharacters } from '../../../server/characters';

/**
 * The cast of one anime, for the character picker in the admin panel. Admin only.
 * The browser cannot ask AniList itself (the page's Content-Security-Policy only
 * allows requests to this site), so the request goes through here.
 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env, params }) => {
  if (!(await authenticate(request, env))) return json({ error: 'Not signed in.' }, 401);
  const malId = Number(params.malId);
  if (!Number.isInteger(malId) || malId <= 0) return json({ error: 'Invalid MAL id.' }, 400);
  if (env.CHARACTER_LOOKUP === 'off') return json({ characters: [] });
  try {
    const cast = await fetchCharacters(malId, fetch, 1);
    const characters = cast.slice(0, 40).map((c) => ({ name: c.names[0]!, image: c.image }));
    return json({ characters }, 200, { 'Cache-Control': 'private, max-age=3600' });
  } catch {
    return json({ characters: [] }); // the picker is a convenience; typing a name still works
  }
};
