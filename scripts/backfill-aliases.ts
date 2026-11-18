/**
 * Gives every stored annotation that has no aliases yet the OA key of its title, so the notes
 * survive a later change of MAL match. Writes SQL; it changes nothing by itself.
 *
 *   npx tsx scripts/backfill-aliases.ts out.sql
 *   npx wrangler d1 execute DB --remote --file out.sql
 *
 * Safe to run again: it only touches rows whose aliases are still empty.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SITE } from '../src/config/site';
import { sanitizeAnnotationMap } from '../src/lib/annotations';
import type { Dataset } from '../src/lib/types';

const out = process.argv[2] ?? 'backfill-aliases.sql';
const dataset = JSON.parse(readFileSync('data/anime.json', 'utf8')) as Dataset;
const res = await fetch(new URL('/api/annotations', SITE.url), { headers: { Accept: 'application/json' } });
if (!res.ok) throw new Error(`Could not read the live annotations: HTTP ${res.status}`);
const annotations = sanitizeAnnotationMap(((await res.json()) as { annotations?: unknown }).annotations);

const oaKeyByKey = new Map<string, string>();
for (const e of dataset.entries) if (e.slug && e.key !== `oa:${e.slug}`) oaKeyByKey.set(e.key, `oa:${e.slug}`);
const known = new Set(dataset.entries.flatMap((e) => [e.key, ...(e.slug ? [`oa:${e.slug}`] : [])]));

const sql = (s: string) => `'${s.replace(/'/g, "''")}'`;
const lines: string[] = [];
const orphans: string[] = [];
let already = 0;
for (const [key, a] of Object.entries(annotations)) {
  if (!known.has(key)) orphans.push(key);
  if (a.aliases.length > 0) {
    already++;
    continue;
  }
  const alias = oaKeyByKey.get(key);
  if (!alias) continue;
  lines.push(`UPDATE annotations SET aliases = ${sql(JSON.stringify([alias]))} WHERE key = ${sql(key)} AND aliases IS NULL;`);
}
writeFileSync(out, lines.join('\n') + '\n');
console.log(`${Object.keys(annotations).length} annotations: ${lines.length} to update, ${already} already have aliases`);
console.log(`${orphans.length} not attached to any title on the current list${orphans.length ? `: ${orphans.join(', ')}` : ''}`);
console.log(`SQL written to ${out}`);
