import { authenticate, authMode, type Env } from '../../server/auth';

/** Server-side gate for the /admin page itself: no session, no page. */
export const onRequest: PagesFunction<Env> = async ({ request, env, next }) => {
  const mode = authMode(env);
  if (mode === 'none') {
    return new Response('Admin sign-in is not configured yet. See the README, section "Admin setup".', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const user = await authenticate(request, env);
  if (!user) {
    if (mode === 'github') return Response.redirect(`${new URL(request.url).origin}/api/auth/login`, 302);
    return new Response('Forbidden', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
};
