import type { AnimeEntry, MalInfo, MatchConfidence, OaEntry } from '../../src/lib/types';
import { matchKey, normalizeTitle } from './match';

export type ListSource = 'html' | 'csv' | 'previous';

export interface MergeInput {
  /** Rows from the newest CSV export, or null when there is none. */
  csv: OaEntry[] | null;
  /** True when this CSV has not been processed by an earlier run. */
  csvIsNew: boolean;
  /** Rows from the live list page, or null when the fetch was skipped or blocked. */
  html: OaEntry[] | null;
  /** Entries from the previous data/anime.json (keeps slugs and dates the CSV lacks). */
  previous: OaEntry[] | null;
}

export interface MergeResult {
  entries: OaEntry[];
  source: ListSource;
  notes: string[];
}

/**
 * Decide which source describes my list right now.
 * - The live page is always the newest, so it wins when it was fetched.
 * - Otherwise a CSV I just dropped in wins, borrowing slug / id / date added
 *   from the previous dataset, because the CSV has none of them.
 * - Otherwise the previous dataset is kept as is.
 */
export function mergeSources({ csv, csvIsNew, html, previous }: MergeInput): MergeResult {
  const notes: string[] = [];
  const prevCount = previous?.length ?? 0;

  if (html && html.length > 0) {
    // A page that suddenly lists far fewer rows is more likely a partial response than a real purge.
    if (prevCount > 0 && html.length < prevCount * 0.5) {
      notes.push(`Live list had only ${html.length} rows (previously ${prevCount}); ignored as suspicious.`);
    } else {
      return { entries: dedupe(html, notes), source: 'html', notes };
    }
  }

  if (csv && csv.length > 0 && (csvIsNew || !previous || previous.length === 0)) {
    const known = new Map<string, OaEntry>();
    for (const p of previous ?? []) known.set(matchKey(p.title, p.type), p);
    const entries = csv.map((row) => {
      const old = known.get(matchKey(row.title, row.type));
      return old ? { ...row, oaId: old.oaId, slug: old.slug, addedAt: old.addedAt } : row;
    });
    return { entries: dedupe(entries, notes), source: 'csv', notes };
  }

  if (previous && previous.length > 0) return { entries: previous, source: 'previous', notes };
  throw new Error('No list data: add a CSV export to data/import/ or let the live list fetch succeed.');
}

/** Drop repeated rows (same OA id, or same title + type when there is no id). */
function dedupe(entries: OaEntry[], notes: string[]): OaEntry[] {
  const seen = new Set<string>();
  const out: OaEntry[] = [];
  for (const e of entries) {
    const id = e.oaId !== null ? `id:${e.oaId}` : `t:${matchKey(e.title, e.type)}`;
    if (seen.has(id)) {
      notes.push(`Duplicate row dropped: "${e.title}" (${e.type}).`);
      continue;
    }
    seen.add(id);
    out.push(e);
  }
  return out;
}

export interface ResolvedMatch {
  mal: MalInfo | null;
  confidence: MatchConfidence;
  score: number;
}

/**
 * Join list rows with their MAL data and give every entry a unique, stable key:
 * `mal:<id>` when matched, else `oa:<slug>`, else `title:<normalized title>`.
 * When two rows resolve to the same MAL id, the later one falls back to its OA key.
 */
export function buildEntries(rows: OaEntry[], resolve: (row: OaEntry) => ResolvedMatch): AnimeEntry[] {
  const used = new Set<string>();
  const entries: AnimeEntry[] = [];
  for (const row of rows) {
    const m = resolve(row);
    const candidates = [
      m.mal ? `mal:${m.mal.id}` : null,
      row.slug ? `oa:${row.slug}` : null,
      `title:${normalizeTitle(row.title).replace(/ /g, '-')}`,
    ].filter((k): k is string => k !== null);
    let key = candidates.find((k) => !used.has(k));
    if (!key) {
      let n = 2;
      while (used.has(`${candidates.at(-1)}-${n}`)) n++;
      key = `${candidates.at(-1)}-${n}`;
    }
    used.add(key);
    entries.push({ ...row, key, mal: m.mal, match: { confidence: m.confidence, score: m.score } });
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title, 'en') || a.key.localeCompare(b.key));
}
