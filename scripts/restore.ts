/**
 * Turns the backups in data/backup/ into SQL that puts them back into the database.
 * It writes a file and changes nothing by itself:
 *
 *   npx tsx scripts/restore.ts restore.sql                  # from the current backup
 *   git show <commit>:data/backup/annotations.json > old.json
 *   npx tsx scripts/restore.ts restore.sql old.json          # from an older backup
 *   npx wrangler d1 execute DB --remote --file restore.sql
 *
 * Every backed-up record is written back as it was (insert or replace). Records that exist
 * in the database but not in the backup are left alone.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { sanitizeAnnotationMap } from '../src/lib/annotations';
import { sanitizeEntry } from '../src/lib/entries';

const out = process.argv[2] ?? 'restore.sql';
const annotationsFile = process.argv[3] ?? 'data/backup/annotations.json';
const entriesFile = process.argv[4] ?? 'data/backup/entries.json';

const q = (v: string | number | null): string => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);
const now = new Date().toISOString();
const lines: string[] = [];

const annotations = sanitizeAnnotationMap(JSON.parse(readFileSync(annotationsFile, 'utf8')));
for (const [key, a] of Object.entries(annotations)) {
  lines.push(
    'INSERT OR REPLACE INTO annotations (key, refined_score, review, tags, favorite_character, favorite_character_image, top_order, distinction, aliases, updated_at) VALUES (' +
      [
        q(key),
        q(a.refinedScore),
        q(a.review),
        q(JSON.stringify(a.tags)),
        q(a.favoriteCharacter),
        q(a.favoriteCharacterImage),
        q(a.topOrder),
        q(a.highlight ? '1' : null),
        q(a.aliases.length ? JSON.stringify(a.aliases) : null),
        q(now),
      ].join(', ') +
      ');',
  );
}

let entries = 0;
if (existsSync(entriesFile)) {
  for (const raw of JSON.parse(readFileSync(entriesFile, 'utf8')) as unknown[]) {
    const e = sanitizeEntry(raw);
    if (!e) continue;
    lines.push(`INSERT OR REPLACE INTO manual_entries (mal_id, data, updated_at) VALUES (${e.malId}, ${q(JSON.stringify(e))}, ${q(now)});`);
    entries++;
  }
}

writeFileSync(out, lines.join('\n') + '\n');
console.log(`${Object.keys(annotations).length} annotations and ${entries} manual entries written to ${out}`);
console.log(`Apply with: npx wrangler d1 execute DB --remote --file ${out}`);
