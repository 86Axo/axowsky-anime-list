/**
 * Runs after `astro build`. Writes dist/_headers (Cloudflare Pages) with security
 * headers and a Content-Security-Policy. Inline scripts are allowed by hash, so
 * the policy never needs 'unsafe-inline' for scripts.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve('dist');

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith('.html') ? [join(dir, e.name)] : [],
  );
}

const hashes = new Set<string>();
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/type="application\/(ld\+)?json"/.test(m[1]!)) continue;
    hashes.add(`'sha256-${createHash('sha256').update(m[2]!).digest('base64')}'`);
  }
}

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...hashes].join(' ')}`.trim(),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://cdn.myanimelist.net https://s4.anilist.co",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

const headers = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/data.json
  Cache-Control: public, max-age=300

/admin/*
  X-Robots-Tag: noindex, nofollow
  Cache-Control: no-store
`;

writeFileSync(join(dist, '_headers'), headers);
console.log(`postbuild: wrote dist/_headers (${hashes.size} inline script hash${hashes.size === 1 ? '' : 'es'})`);
