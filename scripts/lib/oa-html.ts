import { mapStatus, mapType, parseProgress, parseScore } from '../../src/lib/status';
import type { OaEntry } from '../../src/lib/types';

export const USER_AGENT =
  'AxowskyAnimeListSync/1.0 (+https://github.com/86Axo/axowsky-anime-list; personal list sync, 1 request/day)';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const cellText = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Parse my public list page (`/anime_list/<id>`).
 * Each row is `<tr id="anime_list_item_<oaId>">` with cells:
 * #, cover, title (+ "Dodane: <date>"), status, score ("0" = not rated), progress, type.
 */
export function parseOaListHtml(html: string): OaEntry[] {
  const entries: OaEntry[] = [];
  const chunks = html.split(/<tr\s+id="anime_list_item_/).slice(1);
  for (const chunk of chunks) {
    const oaId = Number.parseInt(chunk, 10);
    const cells = [...chunk.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].slice(0, 7).map((m) => m[1]!);
    if (cells.length < 7) continue;

    const titleCell = cells[2]!;
    const link = /<a\s+href="\/anime\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(titleCell);
    const title = link ? cellText(link[2]!) : '';
    if (!title) continue;
    const added = /Dodane:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(titleCell);
    const { watched, total } = parseProgress(cellText(cells[5]!));
    const rawStatus = cellText(cells[3]!);

    entries.push({
      oaId: Number.isFinite(oaId) ? oaId : null,
      slug: link ? decodeEntities(link[1]!) : null,
      title,
      status: mapStatus(rawStatus, watched, total),
      rawStatus,
      score: parseScore(cellText(cells[4]!)),
      watched,
      total,
      type: mapType(cellText(cells[6]!)),
      addedAt: added ? `${added[1]}T${added[2]}` : null,
    });
  }
  return entries;
}

/** Returns a reason when the response is a bot check or error rather than the real page. */
export function looksBlocked(status: number, headers: Headers, body: string): string | null {
  const mitigated = headers.get('cf-mitigated');
  if (mitigated) return `Cloudflare challenge (cf-mitigated: ${mitigated})`;
  if (status !== 200) return `HTTP ${status}`;
  if (/Just a moment\.\.\.|challenge-platform|cf-chl-|captcha/i.test(body) && !body.includes('anime_list_item_')) {
    return 'bot-check page';
  }
  return null;
}

/**
 * Minimal robots.txt check: is `path` allowed for our user agent?
 * Uses the most specific matching group (our UA token, else `*`) and the longest matching rule.
 */
export function robotsAllows(robotsTxt: string, path: string, uaToken = 'axowskyanimelistsync'): boolean {
  type Rule = { allow: boolean; rule: string };
  const groups = new Map<string, Rule[]>();
  let current: string[] = [];
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) current = [];
      current.push(value.toLowerCase());
      for (const a of current) if (!groups.has(a)) groups.set(a, []);
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      for (const a of current) groups.get(a)!.push({ allow: field === 'allow', rule: value });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const own = [...groups.entries()].find(([agent]) => agent !== '*' && uaToken.includes(agent));
  const rules = own?.[1] ?? groups.get('*') ?? [];
  let best: Rule | null = null;
  for (const r of rules) {
    if (r.rule === '') continue; // "Disallow:" with no value allows everything
    const pattern = r.rule
      .replace(/[.+?^{}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\$$/, '\u0000')
      .replace(/\$/g, '\\$')
      .replace('\u0000', '$');
    if (!new RegExp('^' + pattern).test(path)) continue;
    if (!best || r.rule.length > best.rule.length || (r.rule.length === best.rule.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

export type FetchResult = { ok: true; entries: OaEntry[] } | { ok: false; reason: string };

/**
 * One polite request for my own public list. If robots.txt disallows it, or a bot
 * check answers instead of the page, this reports why and the caller falls back to
 * the CSV. It never retries and never tries to get around a block.
 */
export async function fetchOaList(listUrl: string): Promise<FetchResult> {
  const url = new URL(listUrl);
  const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html' };
  try {
    const robots = await fetch(new URL('/robots.txt', url), { headers, signal: AbortSignal.timeout(15_000) });
    if (robots.ok) {
      if (!robotsAllows(await robots.text(), url.pathname)) return { ok: false, reason: 'disallowed by robots.txt' };
    } else if (robots.status !== 404) {
      return { ok: false, reason: `robots.txt unavailable (HTTP ${robots.status})` };
    }
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const blocked = looksBlocked(res.status, res.headers, body);
    if (blocked) return { ok: false, reason: blocked };
    const entries = parseOaListHtml(body);
    if (entries.length === 0) return { ok: false, reason: 'page had no list rows' };
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  }
}
