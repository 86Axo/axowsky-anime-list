import { authenticate, authMode, json, type Env } from '../../../server/auth';

const GITHUB_SETTINGS = ['SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ADMIN_GITHUB_ID'] as const;

/**
 * Lets the admin page know whether it is signed in.
 * While sign-in is not configured it also names the settings that are missing
 * (names only, never values), which makes a half-finished setup easy to diagnose.
 */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await authenticate(request, env);
  const mode = authMode(env);
  const missing = mode === 'none' ? GITHUB_SETTINGS.filter((name) => !env[name]) : undefined;
  return json({ authenticated: user !== null, user: user?.name ?? null, mode, missing });
};
