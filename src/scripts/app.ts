import { annotationsFingerprint, sanitizeAnnotationMap } from '../lib/annotations';
import { entriesFingerprint, mergeEntries, sanitizeEntries, type ManualEntry } from '../lib/entries';
import { activityByMonth, annotate, computeStats, inProgress, statusCounts, tierCounts, topRated, type ListItem, type ViewItem } from '../lib/model';
import {
  applyState,
  DEFAULT_DIR,
  DEFAULT_STATE,
  isDefaultFilter,
  PAGE_SIZE,
  parseState,
  stateToQuery,
  type ListState,
  type SortKey,
} from '../lib/query';
import {
  renderActivity,
  renderGenreChart,
  renderHeroCovers,
  renderItems,
  renderOptions,
  renderStats,
  renderTierChart,
  renderTop,
  renderTypeChart,
  renderWatching,
} from '../lib/render';
import { ANIME_TYPES, STATUSES, type AnnotationMap } from '../lib/types';
import { initThemeToggle } from './theme';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The theme toggle must not wait for the data.
initThemeToggle();

// The list data is a separate static file, so the HTML stays small and paints early.
const data = (await (await fetch('/data.json')).json()) as { items: ListItem[]; annotations: AnnotationMap; entries?: unknown };
let annotations = data.annotations;
// Titles I added by hand in the admin panel join my OglądajAnime list here.
let entries: ManualEntry[] = sanitizeEntries(data.entries);
let items: ViewItem[] = annotate(mergeEntries(data.items, entries), annotations);

const state: ListState = parseState(new URLSearchParams(location.search));
let results: ViewItem[] = [];
let shown = 0;

const list = $<HTMLUListElement>('anime-list');
const listWrap = $('list-wrap');
const more = $('list-more');
const empty = $('empty');
const resultCount = $('result-count');
const clearBtn = $<HTMLButtonElement>('clear-filters');
const search = $<HTMLInputElement>('search');
const selGenre = $<HTMLSelectElement>('filter-genre');
const selType = $<HTMLSelectElement>('filter-type');
const selTier = $<HTMLSelectElement>('filter-tier');
const selSort = $<HTMLSelectElement>('sort');
const sortDir = $<HTMLButtonElement>('sort-dir');
const tabs = [...document.querySelectorAll<HTMLButtonElement>('#status-tabs .tab')];
const viewBtns = [...document.querySelectorAll<HTMLButtonElement>('.view-toggle [data-view]')];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** Run a DOM update inside a view transition where the browser supports it. */
function transition(update: () => void): void {
  if (document.startViewTransition && !reducedMotion.matches) document.startViewTransition(update);
  else update();
}

function syncControls(): void {
  for (const t of tabs) t.setAttribute('aria-pressed', String(t.dataset.status === state.status));
  for (const b of viewBtns) b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
  if (search.value !== state.q) search.value = state.q;
  selGenre.value = state.genre;
  selType.value = state.type;
  selTier.value = state.tier;
  selSort.value = state.sort;
  // A filter value that is not an option (stale shared link) is dropped.
  if (selGenre.value !== state.genre) state.genre = '';
  if (selType.value !== state.type) state.type = '';
  if (selTier.value !== state.tier) state.tier = '';
  if (selSort.value !== state.sort) {
    state.sort = DEFAULT_STATE.sort;
    state.dir = DEFAULT_DIR[state.sort];
    selSort.value = state.sort;
  }
  sortDir.dataset.dir = state.dir;
  sortDir.setAttribute('aria-label', `Sort direction: ${state.dir === 'asc' ? 'ascending' : 'descending'}`);
  list.dataset.view = state.view;
  listWrap.dataset.view = state.view;
}

function renderList(): void {
  results = applyState(items, state);
  shown = Math.min(PAGE_SIZE, results.length);
  list.innerHTML = renderItems(results.slice(0, shown));
  updateMeta();
}

function showMore(): void {
  if (shown >= results.length) return;
  const next = results.slice(shown, shown + PAGE_SIZE);
  list.insertAdjacentHTML('beforeend', renderItems(next));
  shown += next.length;
  updateMeta();
}

function updateMeta(): void {
  const filtered = !isDefaultFilter(state);
  resultCount.textContent = filtered
    ? `${results.length} of ${items.length} titles`
    : `Showing all ${items.length} titles`;
  clearBtn.hidden = !filtered;
  empty.hidden = results.length > 0;
  more.hidden = shown >= results.length;
}

function commit({ animate = false } = {}): void {
  syncControls();
  history.replaceState(null, '', location.pathname + stateToQuery(state) + location.hash);
  if (animate) transition(renderList);
  else renderList();
}

function clearFilters(): void {
  Object.assign(state, { status: 'all', q: '', genre: '', type: '', tier: '' });
  commit({ animate: true });
}

// ── Controls ─────────────────────────────────────────────────────────────────
for (const t of tabs) {
  t.addEventListener('click', () => {
    state.status = t.dataset.status ?? 'all';
    commit({ animate: true });
  });
}
for (const b of viewBtns) {
  b.addEventListener('click', () => {
    state.view = b.dataset.view === 'grid' ? 'grid' : 'list';
    commit({ animate: true });
  });
}
search.addEventListener('input', () => {
  state.q = search.value;
  commit();
});
search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && search.value) {
    e.preventDefault();
    search.value = '';
    state.q = '';
    commit();
  }
});
selGenre.addEventListener('change', () => ((state.genre = selGenre.value), commit()));
selType.addEventListener('change', () => ((state.type = selType.value), commit()));
selTier.addEventListener('change', () => ((state.tier = selTier.value), commit()));
selSort.addEventListener('change', () => {
  state.sort = selSort.value as SortKey;
  state.dir = DEFAULT_DIR[state.sort];
  commit();
});
sortDir.addEventListener('click', () => {
  state.dir = state.dir === 'asc' ? 'desc' : 'asc';
  commit();
});
clearBtn.addEventListener('click', clearFilters);
$('empty-clear').addEventListener('click', clearFilters);
$('show-more').addEventListener('click', showMore);

// Load the next rows shortly before the "Show more" button scrolls into view from below.
// Two things keep jumps to a section below the list (such as Charts) exact:
// - the margin only reaches downwards, so being *past* the list never loads more rows;
// - while an in-page link is scrolling the page, loading is paused, because rows added
//   mid-scroll would push the target further down.
let jumping = false;
if ('IntersectionObserver' in window) {
  new IntersectionObserver((entries) => !jumping && entries.some((e) => e.isIntersecting) && showMore(), {
    rootMargin: '0px 0px 600px 0px',
  }).observe(more);
}
document.addEventListener('click', (e) => {
  const link = (e.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
  if (!link) return;
  jumping = true;
  const done = () => {
    jumping = false;
    window.removeEventListener('scrollend', done);
    clearTimeout(timer);
  };
  const timer = setTimeout(done, 1500);
  window.addEventListener('scrollend', done);
});

// "/" focuses the search box, unless the user is already typing somewhere.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
  e.preventDefault();
  search.focus();
  search.select();
});

// Links such as "143 on the watching list" set the filter in place instead of reloading.
document.addEventListener('click', (e) => {
  const link = (e.target as Element).closest<HTMLAnchorElement>('a[data-status-link]');
  if (!link) return;
  e.preventDefault();
  Object.assign(state, { ...DEFAULT_STATE, view: state.view, status: link.dataset.statusLink ?? 'all' });
  commit();
  $('list').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
});

// ── Activity chart tooltip ───────────────────────────────────────────────────
// Listens on the container, so it keeps working when the chart inside is re-rendered.
const activityBox = $('activity-chart');
let activeCol: Element | null = null;
function hideTip(): void {
  activeCol?.classList.remove('is-active');
  activeCol = null;
  const tip = activityBox.querySelector<HTMLElement>('.cols__tip');
  if (tip) tip.hidden = true;
}
activityBox.addEventListener('pointermove', (e) => {
  const chart = activityBox.querySelector<HTMLElement>('.cols');
  const tip = chart?.querySelector<HTMLElement>('.cols__tip');
  const col = (e.target as Element).closest<HTMLElement>('.cols__col');
  if (!chart || !tip || !col) return hideTip();
  if (col === activeCol) return;
  activeCol?.classList.remove('is-active');
  activeCol = col;
  col.classList.add('is-active');
  const [month = '', count = ''] = (col.dataset.tip ?? '').split('|');
  tip.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = count;
  tip.append(strong, document.createTextNode(`added in ${month}`));
  tip.hidden = false;
  const chartBox = chart.getBoundingClientRect();
  const colBox = col.getBoundingClientRect();
  const bar = col.querySelector('.cols__bar')!.getBoundingClientRect();
  const half = tip.offsetWidth / 2;
  const x = Math.min(Math.max(colBox.left + colBox.width / 2 - chartBox.left, half), chartBox.width - half);
  tip.style.insetInlineStart = `${x}px`;
  tip.style.insetBlockStart = `${Math.max(bar.top - chartBox.top, 44)}px`;
});
activityBox.addEventListener('pointerleave', hideTip);

// ── Fresh annotations and hand-added titles ──────────────────────────────────
/** Re-render every section that depends on the list or on my notes. */
function renderAll(): void {
  $('stats').innerHTML = renderStats(computeStats(items));
  const watching = inProgress(items);
  $('watch-row').innerHTML = renderWatching(watching.shown, watching.totalWatching);
  const top = topRated(items);
  $('top-list').innerHTML = renderTop(top);
  $('hero-covers').innerHTML = renderHeroCovers(top);
  $('tier-chart').innerHTML = renderTierChart(tierCounts(items));
  $('type-chart').innerHTML = renderTypeChart(items);
  $('genre-chart').innerHTML = renderGenreChart(items);
  $('activity-chart').innerHTML = renderActivity(activityByMonth(items));

  // Counts and filter options were rendered at build time; a hand-added title can change them.
  const counts = statusCounts(items);
  $('list-total').textContent = `${items.length} titles`;
  for (const tab of tabs) {
    const count = tab.querySelector('.tab__count');
    const status = STATUSES.find((s) => s.toLowerCase().replace(/ /g, '-') === tab.dataset.status);
    if (count) count.textContent = String(status ? counts[status] : items.length);
  }
  const genres = [...new Set(items.flatMap((i) => i.genres))].sort();
  if (genres.join('|') !== [...selGenre.options].slice(1).map((o) => o.value).join('|')) {
    selGenre.innerHTML = renderOptions('All genres', genres);
  }
  const types = ANIME_TYPES.filter((t) => items.some((i) => i.type === t));
  if (types.join('|') !== [...selType.options].slice(1).map((o) => o.value).join('|')) {
    selType.innerHTML = renderOptions('All types', [...types]);
  }
  syncControls();
  renderList();
}

async function getFresh<T>(path: string, field: string): Promise<T | undefined> {
  // Always ask the server: an edit made in the admin panel should show on the very next page view.
  const res = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
  return ((await res.json()) as Record<string, T>)[field];
}

async function refresh(): Promise<void> {
  try {
    const [freshAnnotations, freshEntries] = await Promise.all([
      getFresh<unknown>('/api/annotations', 'annotations'),
      getFresh<unknown>('/api/entries', 'entries'),
    ]);
    let changed = false;
    if (freshAnnotations !== undefined) {
      const next = sanitizeAnnotationMap(freshAnnotations);
      if (annotationsFingerprint(next) !== annotationsFingerprint(annotations)) {
        annotations = next;
        changed = true;
      }
    }
    if (freshEntries !== undefined) {
      const next = sanitizeEntries(freshEntries);
      if (entriesFingerprint(next) !== entriesFingerprint(entries)) {
        entries = next;
        changed = true;
      }
    }
    if (!changed) return;
    items = annotate(mergeEntries(data.items, entries), annotations);
    renderAll();
  } catch {
    /* API unreachable: the page keeps the data it was built with */
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
syncControls();
const untouched = isDefaultFilter(state) && state.sort === DEFAULT_STATE.sort && state.dir === DEFAULT_STATE.dir;
if (untouched) {
  // The server already rendered this exact view; adopt it without touching the DOM.
  results = applyState(items, state);
  shown = Math.min(PAGE_SIZE, results.length);
  updateMeta();
} else renderList();
void refresh();
