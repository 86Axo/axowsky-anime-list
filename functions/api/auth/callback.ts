import {
  authMode,
  clearCookie,
  newSessionPayload,
  readCookie,
  sessionCookie,
  signSession,
  STATE_COOKIE,
  type Env,
} from '../../../server/auth';

const fail = (message: string, status: number): Response =>
  new Response(`${message}\n\nGo back to /admin to try again.`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': clearCookie(STATE_COOKIE) },
  });

/** GitHub redirects here after sign-in. Only the configured GitHub account gets a session. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (authMode(env) !== 'github') return fail('GitHub sign-in is not configured.', 503);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expected = readCookie(request, STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) return fail('Sign-in failed: the request could not be verified.', 400);

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/api/auth/callback`,
    }),
  });
  const token = tokenRes.ok ? ((await tokenRes.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return fail('Sign-in failed: GitHub did not issue a token.', 502);

  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'axowsky-anime-list' },
  });
  if (!userRes.ok) return fail('Sign-in failed: could not read the GitHub profile.', 502);
  const user = (await userRes.json()) as { id?: number; login?: string };
  // The numeric id never changes, unlike a login name that can be renamed and re-registered.
  if (!user.id || String(user.id) !== env.ADMIN_GITHUB_ID) return fail('This GitHub account is not allowed to edit this site.', 403);

  const session = await signSession(newSessionPayload(user.id, user.login ?? 'admin'), env.SESSION_SECRET!);
  const headers = new Headers({ Location: `${url.origin}/admin`, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', sessionCookie(session));
  headers.append('Set-Cookie', clearCookie(STATE_COOKIE));
  return new Response(null, { status: 302, headers });
};
