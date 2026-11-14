/**
 * HTML string templates shared by the static build and the browser.
 * The page is rendered once at build time; the client re-uses the same functions
 * when filters change or fresh annotations arrive, so both always agree.
 * Every value that comes from data goes through esc().
 */
import { tierById, tierFor } from '../config/rating';
import type { Activity, Stats, ViewItem } from './model';
import { statusSlug } from './query';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (ch) => ESC[ch]!);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string): string => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const fmt = (n: number): string => n.toLocaleString('en-US');

/** `S · 92 · Exceptional`. `compact` drops the label. */
export function tierBadge(score: number | null, compact = false): string {
  const tier = tierFor(score);
  if (!tier || score === null) return `<span class="tier tier--none">${compact ? '–' : 'Not rated'}</span>`;
  return (
    `<span class="tier" data-tier="${tier.id}" title="${esc(`${tier.name} · ${score} · ${tier.label}`)}">` +
    `<span class="tier__name">${esc(tier.name)}</span>` +
    `<span class="tier__num">${score}</span>` +
    (compact ? `<span class="vh"> ${esc(tier.label)}</span>` : `<span class="tier__label">${esc(tier.label)}</span>`) +
    `</span>`
  );
}

/** MAL page for a title. Unmatched titles link to a MAL search instead. */
export const malUrl = (item: Pick<ViewItem, 'malId' | 'title'>): string =>
  item.malId !== null
    ? `https://myanimelist.net/anime/${item.malId}`
    : `https://myanimelist.net/anime.php?q=${encodeURIComponent(item.title)}&cat=anime`;

/**
 * Larger version of a cover. MAL serves ~425px under the same name with an "l" suffix;
 * AniList (the backup source) keeps its sizes in sibling folders.
 */
export const largeCover = (url: string): string =>
  url.includes('anilist.co') ? url.replace('/cover/medium/', '/cover/large/') : url.replace(/(\.\w+)$/, 'l$1');

interface CoverOptions {
  large?: boolean;
  eager?: boolean;
  sizes?: string;
}

/** Cover image with a fixed 225:318 box so nothing shifts while it loads. */
export function cover(item: ViewItem, { large = false, eager = false, sizes }: CoverOptions = {}): string {
  if (!item.image) {
    return `<span class="cover cover--empty" aria-hidden="true">${esc(item.title.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toUpperCase())}</span>`;
  }
  const srcset = large ? ` srcset="${esc(item.image)} 225w, ${esc(largeCover(item.image))} 425w" sizes="${esc(sizes ?? '225px')}"` : '';
  return (
    `<img class="cover" src="${esc(item.image)}"${srcset} width="225" height="318" alt="${esc(item.title)} cover"` +
    ` loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>`
  );
}

const titleLink = (item: ViewItem, cls: string): string =>
  `<a class="${cls}" href="${esc(malUrl(item))}" target="_blank" rel="noopener">${esc(item.title)}</a>`;

const progressText = (item: ViewItem): string => `${item.watched} / ${item.total ?? '?'}`;

function progressBar(item: ViewItem): string {
  const pct = item.total ? Math.min(100, Math.round((item.watched / item.total) * 100)) : 0;
  const label = item.total ? `${item.watched} of ${item.total} episodes watched` : `${item.watched} episodes watched, total unknown`;
  return (
    `<span class="progress" role="img" aria-label="${esc(label)}">` +
    `<span class="progress__track"><span class="progress__fill" style="inline-size:${pct}%"></span></span>` +
    `<span class="progress__text" aria-hidden="true">${esc(progressText(item))}</span></span>`
  );
}

// ── Profile stats ────────────────────────────────────────────────────────────

export function renderStats(s: Stats): string {
  const tier = tierFor(s.meanScore === null ? null : Math.round(s.meanScore));
  const stat = (label: string, value: string, note = ''): string =>
    `<div class="stat"><dt class="stat__label">${esc(label)}</dt><dd class="stat__value">${value}` +
    (note ? `<span class="stat__note">${note}</span>` : '') +
    `</dd></div>`;
  return [
    stat('Anime', fmt(s.total)),
    stat('Completed', fmt(s.completed)),
    stat('Episodes', fmt(s.episodes)),
    stat('Hours watched', s.hours === null ? '–' : fmt(s.hours), s.hours === null ? '' : `${(s.hours / 24).toFixed(1)} days`),
    stat(
      'Mean score',
      s.meanScore === null ? '–' : s.meanScore.toFixed(1),
      tier ? `${esc(tier.name)} · ${esc(tier.label)} · ${s.rated} rated` : '',
    ),
    stat('Top genre', s.topGenre ? esc(s.topGenre.name) : '–', s.topGenre ? `${s.topGenre.count} titles` : ''),
  ].join('');
}

// ── Currently watching ───────────────────────────────────────────────────────

export function renderWatching(shown: ViewItem[], totalWatching: number): string {
  if (shown.length === 0) return `<li class="watch-empty">Nothing in progress right now.</li>`;
  const cards = shown.map(
    (item) =>
      `<li class="watch-card">` +
      `<div class="watch-card__cover">${cover(item)}</div>` +
      titleLink(item, 'watch-card__title cover-link') +
      progressBar(item) +
      (item.final === null ? '' : tierBadge(item.final, true)) +
      `</li>`,
  );
  if (totalWatching > shown.length) {
    cards.push(
      `<li class="watch-card watch-card--more"><a href="?status=watching#list" data-status-link="watching">` +
        `<span class="watch-card__more-num">${totalWatching}</span><span>on the watching list</span><span aria-hidden="true">→</span></a></li>`,
    );
  }
  return cards.join('');
}

// ── Top 10 ───────────────────────────────────────────────────────────────────

export function renderTop(items: ViewItem[]): string {
  if (items.length === 0) return `<li class="top-empty">No rated titles yet.</li>`;
  return items
    .map((item, idx) => {
      const rank = idx + 1;
      const meta = [item.titleEn, item.type, item.year, item.studio].filter(Boolean).map(esc).join(' · ');
      return (
        `<li class="top-item${rank === 1 ? ' top-item--first' : ''}">` +
        `<span class="top-item__rank" aria-hidden="true">${String(rank).padStart(2, '0')}</span>` +
        `<div class="top-item__cover">${cover(item, rank === 1 ? { large: true, sizes: '(min-width: 720px) 220px, 120px' } : {})}</div>` +
        `<div class="top-item__body"><span class="vh">Rank ${rank}: </span>` +
        titleLink(item, 'top-item__title cover-link') +
        (meta ? `<p class="top-item__meta">${meta}</p>` : '') +
        tierBadge(item.final) +
        `</div></li>`
      );
    })
    .join('');
}

// ── Full list ────────────────────────────────────────────────────────────────

export function renderItem(item: ViewItem): string {
  const meta = [item.titleEn, item.type, item.year, item.studio].filter(Boolean).map(esc).join(' · ');
  const chips = item.tags.length
    ? `<ul class="chips" aria-label="Tags">${item.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
    : '';
  const note =
    item.review || item.favoriteCharacter
      ? `<details class="note"><summary>${item.review ? 'Review' : 'Favorite character'}</summary><div class="note__body">` +
        (item.review ? `<p>${esc(item.review)}</p>` : '') +
        (item.favoriteCharacter ? `<p class="note__fav">Favorite character: ${esc(item.favoriteCharacter)}</p>` : '') +
        `</div></details>`
      : '';
  const added = item.added
    ? `<time datetime="${esc(item.added)}" title="${esc(item.added.replace('T', ' '))}">${monthLabel(item.added)}</time>`
    : '–';
  return (
    `<li class="item" data-key="${esc(item.key)}">` +
    `<div class="item__cover">${cover(item)}</div>` +
    `<div class="item__body">${titleLink(item, 'item__title cover-link')}` +
    (meta ? `<p class="item__meta">${meta}</p>` : '') +
    chips +
    note +
    `</div>` +
    `<span class="item__status"><span class="dot dot--${statusSlug(item.status)}" aria-hidden="true"></span>${esc(item.status)}</span>` +
    `<span class="item__progress"><span class="vh">Progress </span>${esc(progressText(item))}</span>` +
    `<span class="item__score">${tierBadge(item.final)}</span>` +
    `<span class="item__mal"><span class="vh">MAL score </span>${item.malScore === null ? '–' : item.malScore.toFixed(2)}</span>` +
    `<span class="item__added"><span class="vh">Added </span>${added}</span>` +
    `</li>`
  );
}

export const renderItems = (items: ViewItem[]): string => items.map(renderItem).join('');

// ── Charts ───────────────────────────────────────────────────────────────────

export interface BarRow {
  label: string;
  value: number;
  /** Secondary text after the label, e.g. a tier label. */
  sub?: string;
  /** Tier id: the bar takes that tier's color. Without it the bar uses the single chart hue. */
  tier?: string;
}

/**
 * Ranked horizontal bars: label, thin bar on a shared baseline, value at the tip.
 * Every value is printed, so the list is its own table view.
 */
export function barList(rows: BarRow[], total: number): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows
    .map((r) => {
      const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
      const tier = r.tier ? ` data-tier="${esc(r.tier)}"` : '';
      return (
        `<li class="bars__row" title="${esc(`${r.label}: ${r.value} (${share}%)`)}">` +
        `<span class="bars__label">${esc(r.label)}${r.sub ? `<span class="bars__sub"> ${esc(r.sub)}</span>` : ''}</span>` +
        `<span class="bars__plot"><span class="bars__bar"${tier} style="--v:${(r.value / max).toFixed(4)}"></span>` +
        `<span class="bars__value">${fmt(r.value)}</span></span>` +
        `</li>`
      );
    })
    .join('');
}

export function renderTierChart(counts: { id: string; name: string; label: string; count: number }[]): string {
  const total = counts.reduce((s, c) => s + c.count, 0);
  return barList(
    counts.map((c) => ({ label: c.name, sub: tierById(c.id)?.label ?? c.label, value: c.count, tier: c.id })),
    total,
  );
}

/** Round an axis maximum up to a clean number with a clean midpoint. */
export function niceMax(n: number): number {
  if (n <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 4, 5, 10]) if (n <= step * pow) return step * pow;
  return 10 * pow;
}

/** Column chart: titles added to the list per month. One series, so no legend. */
export function renderActivity({ months, bulk }: Activity): string {
  if (months.length === 0) return `<p class="chart-empty">No dates yet.</p>`;
  const max = niceMax(Math.max(...months.map((m) => m.count)));
  const cols = months
    .map((m) => {
      const h = m.count === 0 ? 0 : Math.max(1.5, (m.count / max) * 100);
      const january = m.month.endsWith('-01');
      return (
        `<li class="cols__col${january ? ' cols__col--year' : ''}" data-tip="${esc(`${monthLabel(m.month)}|${m.count}`)}">` +
        `<span class="cols__bar" style="block-size:${h.toFixed(2)}%"></span>` +
        (january ? `<span class="cols__tick">${m.month.slice(0, 4)}</span>` : '') +
        `</li>`
      );
    })
    .join('');
  const rows = months.map((m) => `<tr><th scope="row">${monthLabel(m.month)}</th><td>${m.count}</td></tr>`).join('');
  const bulkNote = bulk
    ? `<p class="chart-note">Not shown: ${bulk.count} titles added in one bulk import on ${Number(bulk.date.slice(8, 10))} ${monthLabel(bulk.date)}.</p>`
    : '';
  return (
    `<div class="cols" role="img" aria-label="${esc(`Column chart of titles added per month, ${monthLabel(months[0]!.month)} to ${monthLabel(months.at(-1)!.month)}. The data table follows.`)}">` +
    `<div class="cols__axis" aria-hidden="true"><span>${max}</span><span>${max / 2}</span><span>0</span></div>` +
    `<ol class="cols__plot" aria-hidden="true">${cols}</ol>` +
    `<div class="cols__tip" hidden></div>` +
    `</div>` +
    bulkNote +
    `<details class="chart-table"><summary>Show as table</summary><div class="chart-table__scroll"><table>` +
    `<thead><tr><th scope="col">Month</th><th scope="col">Titles added</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
  );
}
