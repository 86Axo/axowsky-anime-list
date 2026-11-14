import { STATUSES, type Status } from './types';
import type { ViewItem } from './model';

export type SortKey = 'score' | 'title' | 'added' | 'mal';
export type SortDir = 'asc' | 'desc';
export type ViewMode = 'list' | 'grid';

/** Filter / sort / view state of the full list. Mirrors the URL query string. */
export interface ListState {
  /** `all` or a status slug such as `plan-to-watch`. */
  status: string;
  q: string;
  genre: string;
  type: string;
  /** Tier id, `none` for unrated, or empty for any. */
  tier: string;
  sort: SortKey;
  dir: SortDir;
  view: ViewMode;
}

/** Rows rendered per step; more are added as the reader scrolls. */
export const PAGE_SIZE = 60;

export const SORT_KEYS: readonly SortKey[] = ['score', 'title', 'added', 'mal'];
export const DEFAULT_DIR: Record<SortKey, SortDir> = { score: 'desc', title: 'asc', added: 'desc', mal: 'desc' };

export const DEFAULT_STATE: ListState = {
  status: 'all',
  q: '',
  genre: '',
  type: '',
  tier: '',
  sort: 'score',
  dir: 'desc',
  view: 'list',
};

export const statusSlug = (s: Status): string => s.toLowerCase().replace(/ /g, '-');
export const STATUS_BY_SLUG: Record<string, Status> = Object.fromEntries(STATUSES.map((s) => [statusSlug(s), s]));

export function parseState(params: URLSearchParams): ListState {
  const sortRaw = params.get('sort') ?? '';
  const sort = (SORT_KEYS as readonly string[]).includes(sortRaw) ? (sortRaw as SortKey) : DEFAULT_STATE.sort;
  const dirRaw = params.get('dir');
  const status = params.get('status') ?? 'all';
  return {
    status: status in STATUS_BY_SLUG ? status : 'all',
    q: (params.get('q') ?? '').slice(0, 100),
    genre: params.get('genre') ?? '',
    type: params.get('type') ?? '',
    tier: params.get('tier') ?? '',
    sort,
    dir: dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : DEFAULT_DIR[sort],
    view: params.get('view') === 'grid' ? 'grid' : 'list',
  };
}

/** Query string for a state; defaults are left out so the plain URL stays clean. */
export function stateToQuery(state: ListState): string {
  const p = new URLSearchParams();
  if (state.status !== 'all') p.set('status', state.status);
  if (state.q.trim()) p.set('q', state.q.trim());
  if (state.genre) p.set('genre', state.genre);
  if (state.type) p.set('type', state.type);
  if (state.tier) p.set('tier', state.tier);
  if (state.sort !== DEFAULT_STATE.sort) p.set('sort', state.sort);
  if (state.dir !== DEFAULT_DIR[state.sort]) p.set('dir', state.dir);
  if (state.view !== 'list') p.set('view', state.view);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const isDefaultFilter = (s: ListState): boolean =>
  s.status === 'all' && !s.q.trim() && !s.genre && !s.type && !s.tier;

const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function matchesSearch(item: ViewItem, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = fold([item.title, item.titleEn ?? '', item.studio ?? '', ...item.tags].join(' \n '));
  return tokens.every((t) => hay.includes(t));
}

/** Items without a value always sort last, whichever direction is chosen. */
function compareNullable(a: number | string | null, b: number | string | null, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const c = typeof a === 'string' ? a.localeCompare(b as string) : a - (b as number);
  return dir === 'asc' ? c : -c;
}

export function applyState(items: ViewItem[], state: ListState): ViewItem[] {
  const status = STATUS_BY_SLUG[state.status];
  const tokens = fold(state.q).split(/\s+/).filter(Boolean);
  const filtered = items.filter(
    (i) =>
      (!status || i.status === status) &&
      (!state.genre || i.genres.includes(state.genre)) &&
      (!state.type || i.type === state.type) &&
      (!state.tier || (state.tier === 'none' ? i.tierId === null : i.tierId === state.tier)) &&
      matchesSearch(i, tokens),
  );
  const byTitle = (a: ViewItem, b: ViewItem) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
  const cmp: Record<SortKey, (a: ViewItem, b: ViewItem) => number> = {
    score: (a, b) => compareNullable(a.final, b.final, state.dir),
    title: (a, b) => (state.dir === 'asc' ? byTitle(a, b) : byTitle(b, a)),
    added: (a, b) => compareNullable(a.added, b.added, state.dir),
    mal: (a, b) => compareNullable(a.malScore, b.malScore, state.dir),
  };
  return filtered.sort((a, b) => cmp[state.sort](a, b) || byTitle(a, b));
}
