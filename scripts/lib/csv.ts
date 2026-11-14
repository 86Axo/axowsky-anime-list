import { mapStatus, mapType, parseProgress, parseScore } from '../../src/lib/status';
import type { OaEntry } from '../../src/lib/types';

/** Decode a CSV export: UTF-8 (with or without BOM), falling back to Windows-1250. */
export function decodeCsv(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1250').decode(buf);
  }
}

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, embedded newlines. */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      /* swallowed; the following \n ends the row */
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

const COLUMNS = {
  title: ['tytuł', 'tytul', 'title'],
  status: ['status'],
  score: ['ocena', 'score'],
  progress: ['postęp', 'postep', 'progress'],
  type: ['typ', 'type'],
} as const;

/**
 * Parse the OglądajAnime list export.
 * Real header (2026-11): "#","Okładka","Tytuł","Status","Ocena","Postęp","Typ".
 * There is no slug and no date added; those only exist in the list HTML.
 */
export function parseOaCsv(text: string): OaEntry[] {
  const rows = parseCsvRows(text);
  const header = rows[0];
  if (!header) throw new Error('CSV is empty');
  const names = header.map((h) => h.trim().toLowerCase());
  const col = (key: keyof typeof COLUMNS): number => {
    const idx = names.findIndex((n) => (COLUMNS[key] as readonly string[]).includes(n));
    if (idx === -1) throw new Error(`CSV is missing the "${COLUMNS[key][0]}" column (found: ${header.join(', ')})`);
    return idx;
  };
  const iTitle = col('title');
  const iStatus = col('status');
  const iScore = col('score');
  const iProgress = col('progress');
  const iType = col('type');

  const entries: OaEntry[] = [];
  for (const r of rows.slice(1)) {
    const title = (r[iTitle] ?? '').trim();
    if (!title) continue;
    const { watched, total } = parseProgress(r[iProgress] ?? '');
    const rawStatus = (r[iStatus] ?? '').trim();
    entries.push({
      oaId: null,
      slug: null,
      title,
      status: mapStatus(rawStatus, watched, total),
      rawStatus,
      score: parseScore(r[iScore] ?? ''),
      watched,
      total,
      type: mapType(r[iType] ?? ''),
      addedAt: null,
    });
  }
  return entries;
}

/** Pull a date out of an export filename like `moja lista ogladajanime.pl_14.11.2026.csv`. */
export function dateFromCsvName(name: string): string | null {
  const dmy = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(name);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  const ymd = /(\d{4})-(\d{2})-(\d{2})/.exec(name);
  return ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : null;
}
