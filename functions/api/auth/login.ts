import { authMode, cookie, json, STATE_COOKIE, type Env } from '../../../server/auth';

/** Start GitHub sign-in. No scopes are requested: only the public profile is read. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const mode = authMode(env);
  const origin = new URL(request.url).origin;
  if (mode === 'access') return Response.redirect(`${origin}/admin`, 302);
  if (mode === 'none') return json({ error: 'Admin sign-in is not configured.' }, 503);

  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', env.GITHUB_CLIENT_ID!);
  url.searchParams.set('redirect_uri', `${origin}/api/auth/callback`);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'false');
  return new Response(null, {
    status: 302,
    headers: { Location: url.href, 'Set-Cookie': cookie(STATE_COOKIE, state, 600), 'Cache-Control': 'no-store' },
  });
};
