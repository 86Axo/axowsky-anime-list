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
import { AniListClient, AniListUnavailableError, aniListToMalInfo, BATCH_SIZE, toCandidate, type AniListMedia } from './lib/anilist';
import { dateFromCsvName, decodeCsv, parseOaCsv } from './lib/csv';
import { JikanClient, JikanUnavailableError, jikanYear, toMalInfo, type JikanAnime } from './lib/jikan';
import { jikanTypeParam, matchKey, normalizeTitle, pickBestMatch, searchQueries, shortenQuery, type MatchResult } from './lib/match';
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
/** Upgrading AniList backup data to MAL data is one request per title; allow a whole list in one run. */
const MAX_UPGRADE_PER_RUN = 500;
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
  /** Set when the match came from the AniList backup instead of Jikan. */
  source?: 'anilist';
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
      console.warn(`  Jikan is unavailable (${err.message}).`);
      return undefined;
    }
  };

  const searchAndMatch = async (row: OaEntry): Promise<MatchRecord> => {
    const pool = new Map<number, JikanAnime>();
    const run = async (query: string, type: string | null) => {
      for (const a of await client.search(query, type)) pool.set(a.mal_id, a);
      const candidates = [...pool.values()].map((a) => ({ ...a, year: jikanYear(a) }));
      return pickBestMatch(row.title, row.type, row.total, candidates);
    };
    const settled = (r: MatchResult) => r.confidence === 'exact' || r.confidence === 'high';

    const full = shortenQuery(row.title, 100);
    let result = await run(full, jikanTypeParam(row.type));
    // Not convincing? Search again without the type filter, then with progressively looser queries.
    if (!settled(result) && jikanTypeParam(row.type)) result = await run(full, null);
    for (const query of searchQueries(row.title)) {
      if (settled(result)) break;
      if (query !== full) result = await run(query, null);
    }

    if (result.malId !== null) storeAnime(pool.get(result.malId)!);
    return { title: row.title, ...result, checkedAt: today };
  };

  // What needs looking up this run.
  const todo: OaEntry[] = [];
  /** Titles whose AniList answer was weak: worth asking Jikan again, but not AniList. */
  const jikanOnly = new Set<OaEntry>();
  const overrideIds = new Set<number>();
  for (const row of merged.entries) {
    const override = overrideFor(row);
    if (override !== undefined) {
      if (override !== null && !cache.anime[String(override)]) overrideIds.add(override);
      continue;
    }
    const cached = cache.matches[matchKey(row.title, row.type)];
    if (!cached || (cached.malId === null && daysSince(cached.checkedAt) >= RETRY_UNMATCHED_DAYS)) todo.push(row);
    else if (cached.source === 'anilist' && (cached.malId === null || cached.confidence === 'low')) {
      todo.push(row);
      jikanOnly.add(row);
    }
  }

  // First choice: Jikan (MyAnimeList data).
  let searched = 0;
  const saveRecord = (row: OaEntry, record: MatchRecord) => {
    cache.matches[matchKey(row.title, row.type)] = record;
    cacheDirty = true;
    if (++searched % 25 === 0) {
      saveCache();
      console.log(`  matched ${searched} titles…`);
    }
  };
  const leftoverIds: number[] = [];
  for (const id of overrideIds) {
    const a = await guard(() => client.byId(id));
    if (a) storeAnime(a);
    else if (a === null) console.warn(`  overrides.json: MAL id ${id} does not exist`);
    else leftoverIds.push(id);
  }
  const leftover: OaEntry[] = [];
  for (const row of todo) {
    const record = await guard(() => searchAndMatch(row));
    if (record) saveRecord(row, record);
    else if (!jikanOnly.has(row)) leftover.push(row);
  }

  // Backup: AniList, only for what Jikan could not answer because it is down.
  const anilist = new AniListClient();
  let viaAniList = 0;
  if (!OFFLINE && (leftover.length > 0 || leftoverIds.length > 0)) {
    console.log(`  Using AniList as a backup for ${leftover.length} titles.`);
    const storeAniList = (m: AniListMedia) => {
      const existing = cache.anime[String(m.idMal)];
      if (existing && existing.data.source !== 'anilist') return; // never replace MAL data with backup data
      cache.anime[String(m.idMal)] = { fetchedAt: today, data: aniListToMalInfo(m) };
      cacheDirty = true;
    };
    try {
      for (let i = 0; i < leftoverIds.length; i += 50) {
        for (const m of await anilist.byMalIds(leftoverIds.slice(i, i + 50))) if (m.idMal !== null) storeAniList(m);
      }

      const pools = new Map<OaEntry, Map<number, AniListMedia>>(leftover.map((row) => [row, new Map()]));
      const pick = (row: OaEntry): MatchResult =>
        pickBestMatch(
          row.title,
          row.type,
          row.total,
          [...pools.get(row)!.values()].map(toCandidate).filter((c) => c !== null),
          { lenientTypes: true }, // AniList files many shows under a different format than MAL
        );
      const settled = (r: MatchResult) => r.confidence === 'exact' || r.confidence === 'high';

      // Up to four passes with progressively looser queries; each pass only asks about titles still unsettled.
      const queries = new Map(leftover.map((row) => [row, searchQueries(row.title)]));
      for (let pass = 0; pass < 4; pass++) {
        const rows = leftover.filter((row) => queries.get(row)![pass] !== undefined && !settled(pick(row)));
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          const results = await anilist.searchMany(batch.map((row) => queries.get(row)![pass]!));
          batch.forEach((row, j) => {
            for (const m of results[j] ?? []) if (m.idMal !== null) pools.get(row)!.set(m.idMal, m);
          });
        }
      }

      for (const row of leftover) {
        const result = pick(row);
        if (result.malId !== null) storeAniList(pools.get(row)!.get(result.malId)!);
        saveRecord(row, { title: row.title, ...result, checkedAt: today, source: 'anilist' });
        viaAniList++;
      }
    } catch (err) {
      if (!(err instanceof AniListUnavailableError)) throw err;
      console.warn(`  AniList is unavailable too (${err.message}). The next run will continue.`);
    }
  }
  // Two list rows must not share one MAL entry. Keep the better-supported claim and
  // flag the others as low confidence, so they show up in the report for a manual check.
  const claims = new Map<number, OaEntry[]>();
  for (const row of merged.entries) {
    if (overrideFor(row) !== undefined) continue;
    const rec = cache.matches[matchKey(row.title, row.type)];
    if (rec && rec.malId !== null) claims.set(rec.malId, [...(claims.get(rec.malId) ?? []), row]);
  }
  const rank: Record<MatchConfidence, number> = { override: 4, exact: 3, high: 2, low: 1, none: 0 };
  for (const [malId, rows] of claims) {
    if (rows.length < 2) continue;
    const malTitle = cache.anime[String(malId)]?.data.title.trim().toLowerCase();
    const strength = (row: OaEntry): number => {
      const rec = cache.matches[matchKey(row.title, row.type)]!;
      return (row.title.trim().toLowerCase() === malTitle ? 10 : 0) + rank[rec.confidence] + rec.score;
    };
    for (const row of [...rows].sort((a, b) => strength(b) - strength(a)).slice(1)) {
      const rec = cache.matches[matchKey(row.title, row.type)]!;
      if (rec.confidence !== 'low') {
        rec.confidence = 'low';
        cacheDirty = true;
      }
    }
  }
  saveCache();

  const pending = todo.filter((row) => !cache.matches[matchKey(row.title, row.type)]).map((row) => row.title);

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
  const cachedInUse = [...inUse].map((id) => cache.anime[String(id)]!);
  // Entries that only have AniList backup data are upgraded to MAL data as soon as Jikan answers.
  const upgrades = cachedInUse.filter(({ data }) => data.source === 'anilist').slice(0, MAX_UPGRADE_PER_RUN);
  const aged = cachedInUse
    .filter(({ fetchedAt, data }) => {
      if (data.source === 'anilist') return false;
      const limit = data.airing || data.airStatus === 'Not yet aired' ? REFRESH_AIRING_DAYS : REFRESH_FINISHED_DAYS;
      return daysSince(fetchedAt) >= limit;
    })
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))
    .slice(0, MAX_REFRESH_PER_RUN);
  const stale = [...upgrades, ...aged];
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
      `  pending:      ${pending.length}${pending.length ? '   (no source reachable; will retry next run)' : ''}`,
      `  from AniList: ${entries.filter((e) => e.mal?.source === 'anilist').length}   (backup data; replaced by MAL data once Jikan answers)`,
      `Jikan requests: ${client.requests} (${searched - viaAniList} titles matched, ${refreshed} refreshed)`,
      `AniList requests: ${anilist.requests} (${viaAniList} titles matched)`,
      `Dataset:        ${changed ? 'updated' : 'unchanged'}`,
    ].join('\n'),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
