/**
 * Authentication for /admin and the write API. No passwords are handled here.
 *
 * Two ways in, both enforced on the server:
 *   1. GitHub sign-in (OAuth). Only the GitHub account whose numeric id equals
 *      ADMIN_GITHUB_ID gets a session. The session is a signed, HttpOnly cookie.
 *   2. Cloudflare Access, when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set. The
 *      Access JWT is verified against the team's public keys on every request.
 *
 * If neither is configured, every protected request is rejected.
 */
export interface Env {
  DB: D1Database;
  SESSION_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ADMIN_GITHUB_ID?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

export interface AdminUser {
  name: string;
  via: 'github' | 'access';
}

export const SESSION_COOKIE = '__Host-axo_session';
export const STATE_COOKIE = '__Host-axo_oauth_state';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const encoder = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromB64url = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface SessionPayload {
  /** GitHub numeric user id. */
  sub: string;
  login: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

export async function verifySession(token: string, secret: string, now = Date.now()): Promise<SessionPayload | null> {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig), encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.login !== 'string' || typeof payload.exp !== 'number') return null;
    return payload.exp * 1000 > now ? payload : null;
  } catch {
    return null;
  }
}

export function newSessionPayload(id: number | string, login: string, now = Date.now()): SessionPayload {
  return { sub: String(id), login, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx !== -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** `__Host-` cookies are bound to this exact host, sent over HTTPS only and hidden from scripts. */
export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export const sessionCookie = (token: string): string => cookie(SESSION_COOKIE, token, SESSION_TTL_SECONDS);
export const clearCookie = (name: string): string => cookie(name, '', 0);

export function authMode(env: Env): 'access' | 'github' | 'none' {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) return 'access';
  if (env.SESSION_SECRET && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.ADMIN_GITHUB_ID) return 'github';
  return 'none';
}

// ── Cloudflare Access ────────────────────────────────────────────────────────

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}
let jwksCache: { domain: string; at: number; keys: Jwk[] } | null = null;

async function accessKeys(domain: string): Promise<Jwk[]> {
  if (jwksCache && jwksCache.domain === domain && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  jwksCache = { domain, at: Date.now(), keys };
  return keys;
}

async function verifyAccessJwt(token: string, env: Env): Promise<AdminUser | null> {
  const domain = env.ACCESS_TEAM_DOMAIN!.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { kid?: string; alg?: string };
    if (header.alg !== 'RS256') return null;
    const jwk = (await accessKeys(domain)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), encoder.encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as {
      aud?: string | string[];
      exp?: number;
      iss?: string;
      email?: string;
      sub?: string;
    };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (claims.iss !== `https://${domain}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
    return { name: claims.email ?? claims.sub ?? 'access-user', via: 'access' };
  } catch {
    return null;
  }
}

// ── Public helpers ───────────────────────────────────────────────────────────

/** Who is making this request? null when not signed in (or when auth is not configured). */
export async function authenticate(request: Request, env: Env): Promise<AdminUser | null> {
  const mode = authMode(env);
  if (mode === 'access') {
    const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
    return jwt ? verifyAccessJwt(jwt, env) : null;
  }
  if (mode === 'github') {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) return null;
    const session = await verifySession(token, env.SESSION_SECRET!);
    // Re-check the id on every request, so changing ADMIN_GITHUB_ID revokes old sessions.
    return session && session.sub === env.ADMIN_GITHUB_ID ? { name: session.login, via: 'github' } : null;
  }
  return null;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

/**
 * Gate for state-changing requests. Returns the admin, or the Response to send back.
 * Besides the session it requires a same-origin Origin header, which a cross-site
 * form or script cannot forge.
 */
export async function requireAdmin(request: Request, env: Env): Promise<AdminUser | Response> {
  if (authMode(env) === 'none') return json({ error: 'Admin sign-in is not configured.' }, 503);
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin) return json({ error: 'Cross-origin request refused.' }, 403);
  const user = await authenticate(request, env);
  return user ?? json({ error: 'Not signed in.' }, 401);
}
