import { sanitizeEntry, type ManualEntry } from '../src/lib/entries';

interface Row {
  mal_id: number;
  data: string;
}

export async function listEntries(db: D1Database): Promise<ManualEntry[]> {
  const { results } = await db.prepare('SELECT mal_id, data FROM manual_entries ORDER BY mal_id').all<Row>();
  const out: ManualEntry[] = [];
  for (const row of results) {
    try {
      const e = sanitizeEntry({ ...JSON.parse(row.data), malId: row.mal_id });
      if (e) out.push(e);
    } catch {
      /* a corrupt row is skipped rather than breaking the whole list */
    }
  }
  return out;
}

/** Insert or replace one hand-added title. The MAL id in the URL wins over any in the body. */
export async function saveEntry(db: D1Database, malId: number, input: unknown): Promise<ManualEntry | null> {
  const e = sanitizeEntry({ ...(input && typeof input === 'object' ? input : {}), malId });
  if (!e) return null;
  await db
    .prepare(
      `INSERT INTO manual_entries (mal_id, data, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (mal_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    )
    .bind(e.malId, JSON.stringify(e), new Date().toISOString())
    .run();
  return e;
}

export async function deleteEntry(db: D1Database, malId: number): Promise<void> {
  await db.prepare('DELETE FROM manual_entries WHERE mal_id = ?').bind(malId).run();
}
