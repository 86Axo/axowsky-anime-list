/**
 * Sync pipeline: CSV export (+ optional live list page) → Jikan enrichment → data/anime.json.
 *
 *   npm run sync               full run
 *   npm run sync -- --no-oa    skip the live list request, use the CSV / previous data
 *   npm run sync -- --offline  no network at all; rebuild from the CSV and the cache
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE } from '../src/config/site';
import type { AnimeEntry, Dataset, MalInfo, MatchConfidence, OaEntry } from '../src/lib/types';
import { dateFromCsvName, decodeCsv, parseOaCsv } from './lib/csv';
import { JikanClient, JikanUnavailableError, toMalInfo, type JikanAnime } from './lib/jikan';
import { jikanTypeParam, matchKey, normalizeTitle, pickBestMatch, shortenQuery, type MatchResult } from './lib/match';
import { buildEntries, mergeSources, type ResolvedMatch } from './lib/merge';
import { fetchOaList } from './lib/oa-html';
import { renderReport } from './lib/report';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const PATHS = {
  importDir: join(DATA, 'import'),
  dataset: join(DATA, 'anime.json'),
  cache: join(DATA, 'mal-cache.json'),
  overrides: join(DATA, 'overrides.json'),
  report: join(DATA, 'unmatched.md'),
  meta: join(DATA, 'sync-meta.json'),
};

/** Refresh rules for cached MAL data. */
const REFRESH_AIRING_DAYS = 7;
const REFRESH_FINISHED_DAYS = 120;
const RETRY_UNMATCHED_DAYS = 30;
const MAX_REFRESH_PER_RUN = 60;
/** A commit at least this often keeps GitHub from disabling the scheduled workflow. */
const HEARTBEAT_DAYS = 30;

export interface MatchRecord {
  title: string;
  malId: number | null;
  confidence: MatchConfidence;
  score: number;
  matchedTitle: string | null;
  runnerUp: MatchResult['runnerUp'];
  checkedAt: string;
}

interface Cache {
  version: 1;
  /** title+type → which MAL entry it resolved to. */
  matches: Record<string, MatchRecord>;
  /** MAL id → metadata. */
  anime: Record<string, { fetchedAt: string; data: MalInfo }>;
}

interface SyncMeta {
  lastChange: string;
  lastCsv: string | null;
  listSource: string;
}

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const SKIP_OA = OFFLINE || args.has('--no-oa');

const today = new Date().toISOString().slice(0, 10);
const daysSince = (date: string): number => (Date.parse(today) - Date.parse(date)) / 86_400_000;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Write only when the content differs. Returns true when the file changed. */
function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

const stableJson = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

/** Newest CSV in data/import/, by the date in its name, then by modification time. */
function newestCsv(): { name: string; path: string } | null {
  if (!existsSync(PATHS.importDir)) return null;
  const files = readdirSync(PATHS.importDir)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .map((name) => {
      const path = join(PATHS.importDir, name);
      return { name, path, date: dateFromCsvName(name) ?? '', mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.mtime - a.mtime || b.name.localeCompare(a.name));
  return files[0] ?? null;
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
}

async function main(): Promise<void> {
  const meta = readJson<SyncMeta | null>(PATHS.meta, null);
  const previous = readJson<Dataset | null>(PATHS.dataset, null);
  const cache = readJson<Cache>(PATHS.cache, { version: 1, matches: {}, anime: {} });
  const overridesFile = readJson<Record<string, unknown>>(PATHS.overrides, {});

  // ── 1. My list ────────────────────────────────────────────────────────────
  const csvFile = newestCsv();
  let csvRows: OaEntry[] | null = null;
  if (csvFile) {
    csvRows = parseOaCsv(decodeCsv(readFileSync(csvFile.path)));
    console.log(`CSV: ${csvFile.name} → ${csvRows.length} rows`);
  } else console.log('CSV: none found in data/import/');

  let htmlRows: OaEntry[] | null = null;
  if (SKIP_OA) console.log('Live list: skipped');
  else {
    const res = await fetchOaList(SITE.oa.listUrl);
    if (res.ok) {
      htmlRows = res.entries;
      console.log(`Live list: ${htmlRows.length} rows`);
    } else console.log(`Live list: not used (${res.reason}); using the CSV or the last known list instead`);
  }

  const previousRows: OaEntry[] | null = previous
    ? previous.entries.map(({ key: _k, mal: _m, match: _c, ...row }) => row)
    : null;
  const merged = mergeSources({
    csv: csvRows,
    csvIsNew: csvFile !== null && csvFile.name !== meta?.lastCsv,
    html: htmlRows,
    previous: previousRows,
  });
  for (const n of merged.notes) console.log(`  note: ${n}`);
  console.log(`List source: ${merged.source} (${merged.entries.length} entries)`);

  // ── 2. MAL matching ───────────────────────────────────────────────────────
  const overrides = new Map<string, number | null>();
  for (const [k, v] of Object.entries(overridesFile)) {
    if (k.startsWith('_')) continue; // comment keys
    if (v === null || (typeof v === 'number' && Number.isInteger(v) && v > 0)) {
      overrides.set(k, v);
      overrides.set(normalizeTitle(k), v);
    } else console.warn(`  overrides.json: ignoring "${k}" (value must be a MAL id or null)`);
  }
  const overrideFor = (row: OaEntry): number | null | undefined => {
    if (row.slug && overrides.has(row.slug)) return overrides.get(row.slug);
    if (overrides.has(row.title)) return overrides.get(row.title);
    const norm = normalizeTitle(row.title);
    return overrides.has(norm) ? overrides.get(norm) : undefined;
  };

  const client = new JikanClient();
  let jikanDown = OFFLINE;
  let cacheDirty = false;
  const saveCache = () => {
    if (!cacheDirty) return;
    writeIfChanged(PATHS.cache, stableJson({ version: 1, matches: sortedRecord(cache.matches), anime: sortedRecord(cache.anime) }));
    cacheDirty = false;
  };
  const storeAnime = (a: JikanAnime) => {
    cache.anime[String(a.mal_id)] = { fetchedAt: today, data: toMalInfo(a) };
    cacheDirty = true;
  };
  const guard = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (jikanDown) return undefined;
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof JikanUnavailableError)) throw err;
      jikanDown = true;
      console.warn(`  Jikan is unavailable (${err.message}). Keeping cached data; the next run will continue.`);
      return undefined;
    }
  };

  const searchAndMatch = async (row: OaEntry): Promise<MatchRecord> => {
    const pool = new Map<number, JikanAnime>();
    const run = async (query: string, type: string | null) => {
      for (const a of await client.search(query, type)) pool.set(a.mal_id, a);
      return pickBestMatch(row.title, row.type, row.total, [...pool.values()]);
    };
    const settled = (r: MatchResult) => r.confidence === 'exact' || r.confidence === 'high';

    let result = await run(shortenQuery(row.title, 100), jikanTypeParam(row.type));
    // Not convincing? Search again without the type filter, then with a shorter query.
    if (!settled(result) && jikanTypeParam(row.type)) result = await run(shortenQuery(row.title, 100), null);
    if (!settled(result) && row.title.length > 60) result = await run(shortenQuery(row.title, 60), null);

    if (result.malId !== null) storeAnime(pool.get(result.malId)!);
    return { title: row.title, ...result, checkedAt: today };
  };

  let searched = 0;
  const pending: string[] = [];
  for (const row of merged.entries) {
    const mk = matchKey(row.title, row.type);
    const override = overrideFor(row);
    if (override !== undefined) {
      if (override !== null && !cache.anime[String(override)]) {
        const a = await guard(() => client.byId(override));
        if (a) storeAnime(a);
        else if (a === null) console.warn(`  overrides.json: MAL id ${override} for "${row.title}" does not exist`);
      }
      continue;
    }
    const cached = cache.matches[mk];
    const retryUnmatched = cached?.malId === null && daysSince(cached.checkedAt) >= RETRY_UNMATCHED_DAYS;
    if (cached && !retryUnmatched) continue;
    const record = await guard(() => searchAndMatch(row));
    if (!record) {
      if (!cached) pending.push(row.title);
      continue;
    }
    cache.matches[mk] = record;
    cacheDirty = true;
    searched++;
    if (searched % 25 === 0) {
      saveCache();
      console.log(`  matched ${searched} new titles…`);
    }
  }
  saveCache();

  const resolveMatch = (row: OaEntry): ResolvedMatch => {
    const override = overrideFor(row);
    if (override !== undefined) {
      const mal = override === null ? null : (cache.anime[String(override)]?.data ?? null);
      return { mal, confidence: 'override', score: 1 };
    }
    const rec = cache.matches[matchKey(row.title, row.type)];
    if (!rec || rec.malId === null) return { mal: null, confidence: 'none', score: rec?.score ?? 0 };
    return { mal: cache.anime[String(rec.malId)]?.data ?? null, confidence: rec.confidence, score: rec.score };
  };

  // ── 3. Refresh stale MAL data (airing shows weekly, the rest rarely) ──────
  const inUse = new Set<number>();
  for (const row of merged.entries) {
    const mal = resolveMatch(row).mal;
    if (mal) inUse.add(mal.id);
  }
  const stale = [...inUse]
    .map((id) => cache.anime[String(id)]!)
    .filter(({ fetchedAt, data }) => {
      const limit = data.airing || data.airStatus === 'Not yet aired' ? REFRESH_AIRING_DAYS : REFRESH_FINISHED_DAYS;
      return daysSince(fetchedAt) >= limit;
    })
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    .slice(0, MAX_REFRESH_PER_RUN);
  let refreshed = 0;
  for (const item of stale) {
    const a = await guard(() => client.byId(item.data.id));
    if (a === undefined) break;
    if (a) {
      storeAnime(a);
      refreshed++;
    }
  }
  saveCache();

  // ── 4. Dataset + report ───────────────────────────────────────────────────
  const entries: AnimeEntry[] = buildEntries(merged.entries, resolveMatch);
  const dataset: Dataset = { version: 1, entries };
  const records = new Map<string, MatchRecord>();
  for (const e of entries) {
    const rec = cache.matches[matchKey(e.title, e.type)];
    if (rec) records.set(e.key, rec);
  }

  const changed = [
    writeIfChanged(PATHS.dataset, stableJson(dataset)),
    writeIfChanged(PATHS.report, renderReport(entries, records, pending)),
  ].some(Boolean);
  if (!existsSync(PATHS.overrides)) {
    writeFileSync(
      PATHS.overrides,
      stableJson({
        _help: 'Map an OglądajAnime slug or exact title to a MyAnimeList id. Use null to mark a title as having no MAL entry.',
        _example: { 'some-oa-slug': 12345, 'Some Exact OA Title': 67890 },
      }),
    );
  }

  const heartbeatDue = !meta || daysSince(meta.lastChange) >= HEARTBEAT_DAYS;
  const csvName = csvFile?.name ?? meta?.lastCsv ?? null;
  if (changed || heartbeatDue || csvName !== meta?.lastCsv) {
    writeIfChanged(PATHS.meta, stableJson({ lastChange: today, lastCsv: csvName, listSource: merged.source } satisfies SyncMeta));
  }

  // ── 5. Summary ────────────────────────────────────────────────────────────
  const by = (c: MatchConfidence) => entries.filter((e) => e.match.confidence === c).length;
  console.log(
    [
      '',
      `Entries:        ${entries.length}`,
      `  exact:        ${by('exact')}`,
      `  high:         ${by('high')}`,
      `  low:          ${by('low')}   (see data/unmatched.md)`,
      `  override:     ${by('override')}`,
      `  unmatched:    ${by('none') - pending.length}`,
      `  pending:      ${pending.length}${pending.length ? '   (Jikan unavailable; will retry next run)' : ''}`,
      `Jikan requests: ${client.requests} (${searched} titles searched, ${refreshed} refreshed)`,
      `Dataset:        ${changed ? 'updated' : 'unchanged'}`,
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
