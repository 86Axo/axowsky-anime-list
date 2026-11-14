import { clearCookie, json, SESSION_COOKIE, type Env } from '../../../server/auth';

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) return json({ error: 'Cross-origin request refused.' }, 403);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(SESSION_COOKIE) });
};
