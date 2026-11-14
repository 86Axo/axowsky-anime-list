import { authenticate, authMode, json, type Env } from '../../../server/auth';

/** Lets the admin page know whether it is signed in. Never reveals anything else. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await authenticate(request, env);
  return json({ authenticated: user !== null, user: user?.name ?? null, mode: authMode(env) });
};
