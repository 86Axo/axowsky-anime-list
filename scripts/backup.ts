/**
 * Copies my annotations (and manually added titles) from the live API into data/backup/,
 * so every change is kept in the repository's history. Runs in the daily sync.
 *
 *   npx tsx scripts/backup.ts
 *
 * It never replaces a good backup with a bad one: if the API fails, or suddenly returns far
 * fewer records than the last backup, the old file is kept and a warning is printed.
 * Restore with scripts/restore.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { SITE } from '../src/config/site';

const DIR = 'data/backup';
mkdirSync(DIR, { recursive: true });

interface Source {
  file: string;
  path: string;
  /** Name of the field in the API response that holds the records. */
  field: string;
}
const sources: Source[] = [
  { file: 'annotations.json', path: '/api/annotations', field: 'annotations' },
  { file: 'entries.json', path: '/api/entries', field: 'entries' },
];

const count = (v: unknown): number => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);

/** Same content, same text: object keys sorted, so a backup only changes when the data does. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .filter((k) => k !== 'updatedAt')
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

let problems = 0;
for (const { file, path, field } of sources) {
  const target = `${DIR}/${file}`;
  try {
    const res = await fetch(new URL(path, SITE.url), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) {
      console.log(`${file}: ${path} does not exist yet, skipped`);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const records = ((await res.json()) as Record<string, unknown>)[field];
    if (records === undefined) throw new Error(`no "${field}" in the response`);
    const fresh = count(records);
    const previous = existsSync(target) ? count(JSON.parse(readFileSync(target, 'utf8'))) : 0;
    if (previous >= 10 && fresh < previous / 2) {
      throw new Error(`only ${fresh} records where the last backup had ${previous}; keeping the last backup`);
    }
    writeFileSync(target, JSON.stringify(stable(records), null, 2) + '\n');
    console.log(`${file}: ${fresh} records`);
  } catch (err) {
    problems++;
    console.warn(`::warning::Backup of ${file} skipped: ${(err as Error).message}`);
  }
}
if (problems > 0) console.warn(`${problems} backup(s) skipped; the previous copies are unchanged.`);
