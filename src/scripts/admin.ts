import { finalScore } from '../config/rating';
import { aliasesFor, findAnnotation, isEmptyAnnotation, LIMITS, sanitizeAnnotation, sanitizeAnnotationMap } from '../lib/annotations';
import { searchAnime, type Candidate } from '../lib/anilist-search';
import { fetchCharacters, pickCharacter, type CharacterInfo } from '../lib/characters';
import { mergeEntries, nowLocal, sanitizeEntries, sanitizeEntry, supersededEntries, type ManualEntry } from '../lib/entries';
import { annotate, rankRated, type ListItem, type ViewItem } from '../lib/model';
import { tierBadge } from '../lib/render';
import { STATUSES, type Annotation, type AnnotationMap } from '../lib/types';
import { initThemeToggle } from './theme';

initThemeToggle();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const banner = $('adm-banner');
function showBanner(message: string): void {
  banner.textContent = message;
  banner.hidden = false;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const [data, me, annRes, entRes] = await Promise.all([
  getJson<{ items: ListItem[] }>('/data.json'),
  getJson<{ authenticated: boolean; user: string | null; mode: string }>('/api/auth/me'),
  getJson<{ annotations: unknown }>('/api/annotations'),
  getJson<{ entries: unknown }>('/api/entries'),
]);

/** My OglądajAnime list as built; hand-added titles are merged into `items`. */
const baseItems = data?.items ?? [];
let entries: ManualEntry[] = sanitizeEntries(entRes?.entries);
let items: ListItem[] = mergeEntries(baseItems, entries);
const annotations: AnnotationMap = sanitizeAnnotationMap(annRes?.annotations);
const EMPTY: Annotation = sanitizeAnnotation({});

if (baseItems.length === 0) showBanner('Could not load the list data.');
else if (!me) showBanner('The API is not reachable here (it only runs on Cloudflare Pages or `npm run pages:dev`). Saving is disabled.');
else if (!me.authenticated) showBanner('You are not signed in. Saving is disabled.');
else {
  $('adm-user').textContent = `Signed in as ${me.user ?? 'admin'}`;
  if (me.mode === 'github') {
    const logout = $<HTMLButtonElement>('adm-logout');
    logout.hidden = false;
    logout.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      location.href = '/';
    });
  }
}
const canSave = me?.authenticated === true;

// ── Annotation store ─────────────────────────────────────────────────────────

/** The key a title's notes are stored under now (main key, OA key, or an older MAL key via alias). */
const storedKey = (item: ListItem): string | null => findAnnotation(item, annotations)?.key ?? null;
const current = (item: ListItem): Annotation => findAnnotation(item, annotations)?.annotation ?? EMPTY;

/** Save one annotation. Returns what the server stored, or throws with a readable message. */
async function putAnnotation(item: ListItem, next: Annotation): Promise<Annotation> {
  const was = storedKey(item);
  // Notes normally live under the title's main key. If that key already holds another
  // title's notes (a sync matched both to one MAL id), they go under this title's OA key,
  // so neither title's notes are overwritten.
  let target = item.key;
  if (annotations[target] && was !== target) {
    if (!item.altKey) throw new Error('Another title’s notes are stored under this key.');
    target = item.altKey;
  }
  const res = await fetch(`/api/annotations/${encodeURIComponent(target)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...next, aliases: aliasesFor(item, target) }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  const saved = sanitizeAnnotation(((await res.json()) as { annotation?: unknown }).annotation);
  // Notes found under an older key (OA slug, or a previous MAL match) move to the new one.
  if (was && was !== target) {
    await fetch(`/api/annotations/${encodeURIComponent(was)}`, { method: 'DELETE' });
    delete annotations[was];
  }
  if (isEmptyAnnotation(saved)) delete annotations[target];
  else annotations[target] = saved;
  return saved;
}

function setStatus(node: HTMLElement, text: string, kind: 'ok' | 'error' | 'dirty' | '' = ''): void {
  node.textContent = text;
  if (kind) node.dataset.kind = kind;
  else delete node.dataset.kind;
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('.adm-tabs .tab')];
function showPanel(name: string): void {
  for (const b of tabButtons) b.setAttribute('aria-pressed', String(b.dataset.panel === name));
  $('panel-notes').hidden = name !== 'notes';
  $('panel-top').hidden = name !== 'top';
  $('panel-add').hidden = name !== 'add';
  if (name === 'add') renderAddList();
  if (name === 'top') {
    if (touched.size === 0) loadGroups(); // pick up scores changed in the other tab
    renderTopPanel();
  }
}
for (const b of tabButtons) b.addEventListener('click', () => showPanel(b.dataset.panel ?? 'notes'));

// ── Notes and scores ─────────────────────────────────────────────────────────

const list = $<HTMLUListElement>('adm-list');
const search = $<HTMLInputElement>('adm-search');
const statusFilter = $<HTMLSelectElement>('adm-status');
const sortSelect = $<HTMLSelectElement>('adm-sort');
const onlyAnnotated = $<HTMLInputElement>('adm-only');
const template = $<HTMLTemplateElement>('adm-editor');

/** Notes worth showing on a row: everything except a bare Top 10 position. */
const hasNotes = (a: Annotation): boolean =>
  a.refinedScore !== null || a.review !== null || a.tags.length > 0 || a.favoriteCharacter !== null || a.highlight;

const rows = new Map<string, HTMLLIElement>();

function updateHead(item: ListItem): void {
  const row = rows.get(item.key)!;
  const a = current(item);
  const marks = row.querySelector<HTMLElement>('.adm-row__marks')!;
  marks.replaceChildren();
  const badge = el('span');
  badge.innerHTML = tierBadge(finalScore(item.score, a.refinedScore));
  marks.append(badge);
  const add = (text: string) => marks.append(el('span', 'adm-mark', text));
  if (a.highlight) add('✧ honorable mention');
  if (a.refinedScore !== null) add('own score');
  if (a.favoriteCharacter) add(a.favoriteCharacter);
  if (a.tags.length) add(`${a.tags.length} tag${a.tags.length > 1 ? 's' : ''}`);
  if (a.review) add('review');
}

/** Every tag in use, most used first: offered as one-click suggestions. */
function knownTags(): string[] {
  const counts = new Map<string, number>();
  for (const a of Object.values(annotations)) for (const t of a.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

function buildEditor(item: ListItem, row: HTMLLIElement): HTMLFormElement {
  const form = (template.content.cloneNode(true) as DocumentFragment).querySelector('form')!;
  const q = <T extends HTMLElement>(sel: string) => form.querySelector<T>(sel)!;
  const score = q<HTMLInputElement>('[name="refinedScore"]');
  const range = q<HTMLInputElement>('[data-range]');
  const preview = q<HTMLElement>('[data-preview]');
  const character = q<HTMLInputElement>('[name="favoriteCharacter"]');
  const avatar = q<HTMLImageElement>('[data-avatar]');
  const castBox = q<HTMLElement>('[data-cast]');
  const highlightBox = q<HTMLInputElement>('[data-highlight]');
  const tagList = q<HTMLUListElement>('[data-tags]');
  const tagInput = q<HTMLInputElement>('[name="tags"]');
  const suggestBox = q<HTMLElement>('[data-suggest]');
  const review = q<HTMLTextAreaElement>('[name="review"]');
  const counter = q<HTMLElement>('[data-count]');
  const saveBtn = q<HTMLButtonElement>('[data-save]');
  const discardBtn = q<HTMLButtonElement>('[data-discard]');
  const clearBtn = q<HTMLButtonElement>('[data-clear]');
  const status = q<HTMLElement>('.adm-status');

  const base = finalScore(item.score, null);
  q<HTMLElement>('[data-score-hint]').textContent =
    item.score !== null
      ? `Your OglądajAnime score is ${item.score}/10, shown as ${base}. Leave the box empty to keep that.`
      : 'Not rated on OglądajAnime. Leave the box empty to keep it unrated.';

  let tags: string[] = [];
  let cast: CharacterInfo[] = [];

  const parseTags = (raw: string): string[] => sanitizeAnnotation({ tags: raw.split(',') }).tags;
  /** Picture for the typed name: the matching cast member, else the stored one if the name is unchanged. */
  const pictureFor = (name: string): string | null => {
    const typed = name.trim().toLowerCase();
    if (!typed) return null;
    const saved = current(item);
    return (
      cast.find((c) => c.names[0]!.toLowerCase() === typed)?.image ??
      pickCharacter(name, cast)?.image ??
      (saved.favoriteCharacter?.toLowerCase() === typed ? saved.favoriteCharacterImage : null)
    );
  };
  /** The annotation as the form currently describes it. */
  const read = (): Annotation => {
    const raw = score.value.trim();
    return sanitizeAnnotation({
      refinedScore: raw === '' ? null : Number(raw),
      tags: [...tags, ...parseTags(tagInput.value)],
      favoriteCharacter: character.value,
      favoriteCharacterImage: pictureFor(character.value),
      review: review.value,
      highlight: highlightBox.checked,
      topOrder: current(item).topOrder,
    });
  };
  const scoreInvalid = (): boolean => score.value.trim() !== '' && read().refinedScore === null;
  const dirty = (): boolean => {
    const a = current(item);
    const n = read();
    return (
      scoreInvalid() ||
      n.refinedScore !== a.refinedScore ||
      n.review !== a.review ||
      n.favoriteCharacter !== a.favoriteCharacter ||
      // A picture that became available for an unchanged name is worth saving too.
      (n.favoriteCharacterImage !== null && n.favoriteCharacterImage !== a.favoriteCharacterImage) ||
      n.highlight !== a.highlight ||
      n.tags.join('\n') !== a.tags.join('\n')
    );
  };

  function renderTags(): void {
    tagList.replaceChildren(
      ...tags.map((t) => {
        const li = el('li');
        const b = el('button', 'adm-pill adm-pill--text', `${t} ×`);
        b.type = 'button';
        b.setAttribute('aria-label', `Remove tag ${t}`);
        b.addEventListener('click', () => {
          tags = tags.filter((x) => x !== t);
          renderTags();
          refresh();
        });
        li.append(b);
        return li;
      }),
    );
    const suggestions = knownTags()
      .filter((t) => !tags.includes(t))
      .slice(0, 10);
    suggestBox.hidden = suggestions.length === 0;
    suggestBox.replaceChildren(
      ...suggestions.map((t) => {
        const b = el('button', 'adm-pill adm-pill--text', `+ ${t}`);
        b.type = 'button';
        b.addEventListener('click', () => {
          tags = sanitizeAnnotation({ tags: [...tags, t] }).tags;
          renderTags();
          refresh();
        });
        return b;
      }),
    );
  }

  function commitTagInput(): void {
    const added = parseTags(tagInput.value);
    if (added.length === 0) return;
    tags = sanitizeAnnotation({ tags: [...tags, ...added] }).tags;
    tagInput.value = '';
    renderTags();
  }

  function renderCast(): void {
    castBox.hidden = cast.length === 0;
    const chosen = character.value.trim().toLowerCase();
    castBox.replaceChildren(
      ...cast.slice(0, 40).map((c) => {
        const name = c.names[0]!;
        const b = el('button', 'adm-pill');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(name.toLowerCase() === chosen));
        if (c.image) {
          const img = el('img');
          img.src = c.image;
          img.alt = '';
          img.width = 24;
          img.height = 24;
          img.loading = 'lazy';
          b.append(img);
        } else b.classList.add('adm-pill--text');
        b.append(name);
        b.addEventListener('click', () => {
          character.value = name.toLowerCase() === chosen ? '' : name;
          delete status.dataset.kind;
          refresh();
        });
        return b;
      }),
    );
  }

  /** Re-derive everything that depends on the current field values. */
  function refresh(): void {
    const n = read();
    preview.innerHTML = tierBadge(finalScore(item.score, n.refinedScore), false, n.highlight);
    range.value = String(n.refinedScore ?? base ?? 50);
    counter.textContent = `${review.value.length} / ${LIMITS.review}`;

    const picture = n.favoriteCharacterImage;
    avatar.hidden = !picture;
    if (picture) avatar.src = picture;
    else avatar.removeAttribute('src');
    renderCast();

    const isDirty = dirty();
    saveBtn.disabled = !canSave || !isDirty;
    discardBtn.disabled = !isDirty;
    clearBtn.disabled = !canSave || storedKey(item) === null;
    if (scoreInvalid()) setStatus(status, 'The score must be a whole number from 1 to 100.', 'error');
    else if (isDirty) setStatus(status, 'Unsaved changes', 'dirty');
    else if (status.dataset.kind !== 'ok') setStatus(status, '');
    row.toggleAttribute('data-dirty', isDirty);
  }

  function fill(): void {
    const a = current(item);
    score.value = a.refinedScore !== null ? String(a.refinedScore) : '';
    score.placeholder = base !== null ? String(base) : '–';
    character.value = a.favoriteCharacter ?? '';
    review.value = a.review ?? '';
    highlightBox.checked = a.highlight;
    tagInput.value = '';
    tags = [...a.tags];
    renderTags();
    setStatus(status, '');
    refresh();
  }

  async function save(next: Annotation, done: string): Promise<void> {
    setStatus(status, 'Saving…');
    saveBtn.disabled = true;
    try {
      const saved = await putAnnotation(item, next);
      fill();
      updateHead(item);
      applyFilter();
      setStatus(
        status,
        saved.favoriteCharacter && !saved.favoriteCharacterImage ? `${done} No picture was found for that character name.` : done,
        'ok',
      );
    } catch (err) {
      setStatus(status, `Not saved: ${(err as Error).message}`, 'error');
      refresh();
    }
  }

  score.addEventListener('input', () => {
    delete status.dataset.kind;
    refresh();
  });
  range.addEventListener('input', () => {
    score.value = range.value;
    delete status.dataset.kind;
    refresh();
  });
  highlightBox.addEventListener('change', () => {
    delete status.dataset.kind;
    refresh();
  });
  for (const field of [character, review]) {
    field.addEventListener('input', () => {
      delete status.dataset.kind;
      refresh();
    });
  }
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) commitTagInput();
    delete status.dataset.kind;
    refresh();
  });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // Enter adds the tag; it must not submit the form
      commitTagInput();
      refresh();
    } else if (e.key === 'Backspace' && tagInput.value === '' && tags.length > 0) {
      tags = tags.slice(0, -1);
      renderTags();
      refresh();
    }
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !saveBtn.disabled) form.requestSubmit();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (scoreInvalid()) return refresh();
    commitTagInput();
    void save(read(), 'Saved.');
  });
  discardBtn.addEventListener('click', fill);

  // Removing everything asks for a second click instead of opening a dialog.
  let armed: ReturnType<typeof setTimeout> | undefined;
  clearBtn.addEventListener('click', () => {
    if (armed === undefined) {
      clearBtn.textContent = 'Click again to remove';
      armed = setTimeout(() => {
        armed = undefined;
        clearBtn.textContent = 'Remove all notes';
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    clearBtn.textContent = 'Remove all notes';
    // The Top 10 position is not a note; it stays.
    void save(sanitizeAnnotation({ topOrder: current(item).topOrder }), 'Removed.');
  });

  fill();
  // The cast comes straight from AniList. If that fails, typing a name still works; it just has no picture.
  if (item.malId !== null) {
    void fetchCharacters(item.malId, fetch, 2)
      .then((characters) => {
        cast = characters;
        refresh();
      })
      .catch(() => undefined);
  }
  return form;
}

/** A small cover, or the first letter when there is none. */
function thumbFor(t: { image: string | null; title: string }): HTMLElement {
  const thumb = el('span');
  if (t.image) {
    const img = el('img', 'cover');
    img.src = t.image;
    img.alt = '';
    img.width = 225;
    img.height = 318;
    img.loading = 'lazy';
    thumb.append(img);
  } else thumb.append(el('span', 'cover cover--empty', t.title.slice(0, 1).toUpperCase()));
  return thumb;
}

function buildRow(item: ListItem): HTMLLIElement {
  const li = el('li', 'adm-row');
  const head = el('button', 'adm-row__head');
  head.type = 'button';
  head.setAttribute('aria-expanded', 'false');

  const thumb = thumbFor(item);

  const text = el('span');
  text.append(el('span', 'adm-row__title', item.title));
  text.append(el('span', 'adm-row__meta', [item.status, item.type, item.year, item.manual ? 'added by hand' : null].filter(Boolean).join(' · ')));
  head.append(thumb, text, el('span', 'adm-row__marks'), el('span', 'adm-row__chevron'));
  li.append(head);

  head.addEventListener('click', () => {
    const open = li.toggleAttribute('data-open');
    head.setAttribute('aria-expanded', String(open));
    let form = li.querySelector('form');
    if (open && !form) {
      form = buildEditor(item, li); // built on first open only
      li.append(form);
    }
    if (form) form.hidden = !open;
  });
  return li;
}

function applyFilter(): void {
  const tokens = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  const status = statusFilter.value;
  const view = new Map(annotate(items, annotations).map((v) => [v.key, v]));
  const byTitle = (a: ListItem, b: ListItem) => a.title.localeCompare(b.title);
  const sorted = [...items].sort(
    sortSelect.value === 'score'
      ? (a, b) => (view.get(b.key)!.final ?? -1) - (view.get(a.key)!.final ?? -1) || byTitle(a, b)
      : sortSelect.value === 'added'
        ? (a, b) => (b.added ?? '').localeCompare(a.added ?? '') || byTitle(a, b)
        : byTitle,
  );
  let visible = 0;
  for (const item of sorted) {
    const row = rows.get(item.key)!;
    const hay = `${item.title} ${item.titleEn ?? ''}`.toLowerCase();
    // A row with unsaved changes stays visible whatever the filters say.
    const show =
      row.hasAttribute('data-dirty') ||
      (tokens.every((t) => hay.includes(t)) && (!status || item.status === status) && (!onlyAnnotated.checked || hasNotes(current(item))));
    row.hidden = !show;
    if (show) visible++;
    list.append(row); // re-appending moves the row into the sorted position
  }
  $('adm-none').hidden = visible > 0;
  $('adm-count').textContent = `${visible} of ${items.length} shown`;
  const noted = items.filter((i) => hasNotes(current(i))).length;
  $('adm-summary').textContent = `${items.length} titles · ${noted} with notes`;
}

for (const item of items) {
  const row = buildRow(item);
  rows.set(item.key, row);
  updateHead(item);
}
search.addEventListener('input', applyFilter);
statusFilter.addEventListener('change', applyFilter);
sortSelect.addEventListener('change', applyFilter);
onlyAnnotated.addEventListener('change', applyFilter);
applyFilter();

// ── Top 10 order ─────────────────────────────────────────────────────────────

const topGroups = $('top-groups');
const topSave = $<HTMLButtonElement>('top-save');
const topReset = $<HTMLButtonElement>('top-reset');
const topStatus = $('top-status');

/** Working order per score: keys in the order I want them. Only groups I touched are saved. */
let groups: { score: number; keys: string[] }[] = [];
const touched = new Set<number>();
let byKey = new Map(items.map((i) => [i.key, i]));

/** Score groups from the top down, up to and including the group the 10th place falls into. */
function loadGroups(): void {
  const ranked: ViewItem[] = rankRated(annotate(items, annotations));
  groups = [];
  let count = 0;
  for (const v of ranked) {
    const last = groups.at(-1);
    if (last && last.score === v.final) last.keys.push(v.key);
    else if (count >= 10) break;
    else groups.push({ score: v.final!, keys: [v.key] });
    count++;
  }
  touched.clear();
}

const arrow = (up: boolean): string =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${up ? 'M12 19V5M6 11l6-6 6 6' : 'M12 5v14M6 13l6 6 6-6'}"/></svg>`;

function renderTopPanel(focus?: { key: string; up: boolean }): void {
  topGroups.replaceChildren();
  let rank = 0;
  for (const group of groups) {
    const section = el('section', 'top-group');
    const head = el('div', 'top-group__head');
    const badge = el('span');
    badge.innerHTML = tierBadge(group.score);
    head.append(badge, el('span', '', group.keys.length === 1 ? '1 title' : `${group.keys.length} titles share this score`));
    const ol = el('ol');
    group.keys.forEach((key, idx) => {
      rank++;
      const item = byKey.get(key)!;
      const li = el('li', 'top-row');
      if (rank <= 10) li.setAttribute('data-in-top', '');
      if (rank === 10) li.setAttribute('data-cut', '');
      const thumb = el('span');
      if (item.image) {
        const img = el('img', 'cover');
        img.src = item.image;
        img.alt = '';
        img.width = 225;
        img.height = 318;
        img.loading = 'lazy';
        thumb.append(img);
      }
      const moves = el('span', 'top-row__moves');
      for (const up of [true, false]) {
        const b = el('button', 'icon-btn');
        b.type = 'button';
        b.innerHTML = arrow(up);
        b.setAttribute('aria-label', `Move ${item.title} ${up ? 'up' : 'down'}`);
        b.disabled = !canSave || (up ? idx === 0 : idx === group.keys.length - 1);
        b.dataset.key = key;
        b.dataset.up = String(up);
        b.addEventListener('click', () => {
          const to = up ? idx - 1 : idx + 1;
          [group.keys[idx], group.keys[to]] = [group.keys[to]!, group.keys[idx]!];
          touched.add(group.score);
          topSave.disabled = false;
          setStatus(topStatus, 'Unsaved order', 'dirty');
          renderTopPanel({ key, up });
        });
        moves.append(b);
      }
      li.append(el('span', 'top-row__rank', String(rank)), thumb, el('span', 'top-row__title', item.title), moves);
      ol.append(li);
      if (rank === 10 && idx < group.keys.length - 1) {
        const note = el('li', 'top-cutnote', 'The Top 10 ends here');
        ol.append(note);
      }
    });
    section.append(head, ol);
    topGroups.append(section);
  }
  if (groups.length === 0) topGroups.append(el('p', 'adm-none', 'No rated titles yet.'));
  // Keep the keyboard on the title that just moved, on the same arrow when it is still usable.
  if (focus) {
    const buttons = [...topGroups.querySelectorAll<HTMLButtonElement>(`button[data-key="${CSS.escape(focus.key)}"]`)];
    (buttons.find((b) => b.dataset.up === String(focus.up) && !b.disabled) ?? buttons.find((b) => !b.disabled))?.focus();
  }
}

/** Write the given position (or none) for every title of the listed groups whose stored value differs. */
async function saveOrder(scores: number[], position: (index: number) => number | null, done: string): Promise<void> {
  const jobs: { item: ListItem; next: Annotation }[] = [];
  for (const group of groups.filter((g) => scores.includes(g.score))) {
    group.keys.forEach((key, idx) => {
      const item = byKey.get(key)!;
      const a = current(item);
      const topOrder = position(idx);
      if (a.topOrder !== topOrder) jobs.push({ item, next: { ...a, topOrder } });
    });
  }
  topSave.disabled = true;
  topReset.disabled = true;
  try {
    let n = 0;
    for (const job of jobs) {
      setStatus(topStatus, `Saving ${++n} of ${jobs.length}…`);
      await putAnnotation(job.item, job.next);
    }
    loadGroups();
    renderTopPanel();
    setStatus(topStatus, done, 'ok');
  } catch (err) {
    setStatus(topStatus, `Not saved: ${(err as Error).message}`, 'error');
    topSave.disabled = touched.size === 0;
  } finally {
    topReset.disabled = !canSave;
  }
}

topSave.addEventListener('click', () => void saveOrder([...touched], (idx) => idx + 1, 'Order saved.'));
topReset.addEventListener('click', () =>
  void saveOrder(
    groups.map((g) => g.score),
    () => null,
    'Back to automatic order.',
  ),
);
topReset.disabled = !canSave;
loadGroups();

// ── Add anime ────────────────────────────────────────────────────────────────

const addSearch = $<HTMLInputElement>('add-search');
const addSearchStatus = $('add-search-status');
const addResults = $<HTMLUListElement>('add-results');
const addForm = $<HTMLFormElement>('add-form');
const addPick = $('add-pick');
const addStatus = $<HTMLSelectElement>('add-status');
const addWatched = $<HTMLInputElement>('add-watched');
const addOf = $('add-of');
const addScore = $<HTMLInputElement>('add-score');
const addScorePreview = $('add-score-preview');
const addDate = $<HTMLInputElement>('add-date');
const addSubmit = $<HTMLButtonElement>('add-submit');
const addStatusLine = $('add-status-line');
const addList = $<HTMLUListElement>('add-list');

for (const s of STATUSES) addStatus.append(new Option(s, s));

let picked: Candidate | null = null;
let lastResults: Candidate[] = [];
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

/** Is this MAL id already on my OglądajAnime list, or already added by hand? */
function whereIs(malId: number): 'list' | 'manual' | null {
  if (baseItems.some((i) => i.malId === malId)) return 'list';
  if (entries.some((e) => e.malId === malId)) return 'manual';
  return null;
}

const describe = (c: Pick<Candidate, 'titleEn' | 'type' | 'year' | 'total' | 'studio'>): string =>
  [c.titleEn, c.type, c.year, c.total ? `${c.total} ep.` : null, c.studio].filter(Boolean).join(' · ');

function renderResults(): void {
  addResults.replaceChildren(
    ...lastResults.map((c) => {
      const li = el('li');
      const b = el('button', 'add-result');
      b.type = 'button';
      const on = whereIs(c.malId);
      b.disabled = on !== null || !canSave;
      b.setAttribute('aria-pressed', String(picked?.malId === c.malId));
      const text = el('span');
      text.append(el('span', 'add-result__title', c.title), el('span', 'add-result__meta', describe(c)));
      if (on) text.append(el('span', 'add-result__note', on === 'list' ? 'Already on your OglądajAnime list' : 'Already added by hand'));
      b.append(thumbFor(c), text);
      b.addEventListener('click', () => pick(c));
      li.append(b);
      return li;
    }),
  );
}

async function runSearch(): Promise<void> {
  const q = addSearch.value.trim();
  const seq = ++searchSeq;
  if (q.length < 3) {
    lastResults = [];
    renderResults();
    setStatus(addSearchStatus, '');
    return;
  }
  setStatus(addSearchStatus, 'Searching…');
  try {
    const found = await searchAnime(q);
    if (seq !== searchSeq) return; // a newer search has started
    lastResults = found;
    renderResults();
    setStatus(addSearchStatus, found.length ? `${found.length} found` : 'Nothing found. Try the Japanese or the English title.');
  } catch (err) {
    if (seq === searchSeq) setStatus(addSearchStatus, `Search failed: ${(err as Error).message}`, 'error');
  }
}
addSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void runSearch(), 400);
});
addSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(searchTimer);
  void runSearch();
});

/** The score typed in the form: a number 1–100, null when empty, undefined when invalid. */
function typedScore(): number | null | undefined {
  const raw = addScore.value.trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : undefined;
}

function refreshAddForm(): void {
  const score = typedScore();
  addScorePreview.innerHTML = typeof score === 'number' ? tierBadge(score) : '';
  const total = picked?.total ?? null;
  const watched = Number(addWatched.value);
  const watchedOk = addWatched.value !== '' && Number.isInteger(watched) && watched >= 0 && (total === null || watched <= total);
  addSubmit.disabled = !canSave || !picked || score === undefined || !watchedOk || !addDate.value;
  if (score === undefined) setStatus(addStatusLine, 'The score must be a whole number from 1 to 100.', 'error');
  else if (!watchedOk) setStatus(addStatusLine, total ? `Episodes watched must be between 0 and ${total}.` : 'Episodes watched must be 0 or more.', 'error');
  else if (addStatusLine.dataset.kind === 'error') setStatus(addStatusLine, '');
}

function pick(c: Candidate): void {
  picked = c;
  renderResults();
  const text = el('div');
  text.append(el('span', 'add-result__title', c.title), el('span', 'add-result__meta', describe(c)));
  addPick.replaceChildren(thumbFor(c), text);
  addStatus.value = 'Completed';
  addOf.textContent = c.total ? `(of ${c.total})` : '(total not known yet)';
  addWatched.max = c.total ? String(c.total) : '';
  addWatched.value = c.total ? String(c.total) : '0';
  addScore.value = '';
  addDate.value = nowLocal().slice(0, 10);
  addForm.hidden = false;
  setStatus(addStatusLine, '');
  refreshAddForm();
  addStatus.focus();
}

function closeAddForm(): void {
  picked = null;
  addForm.hidden = true;
  renderResults();
}

addStatus.addEventListener('change', () => {
  // Sensible progress for the status just picked; it can still be changed by hand.
  if (addStatus.value === 'Completed' && picked?.total) addWatched.value = String(picked.total);
  if (addStatus.value === 'Plan to Watch') addWatched.value = '0';
  refreshAddForm();
});
for (const f of [addWatched, addScore, addDate]) f.addEventListener('input', refreshAddForm);
$('add-cancel').addEventListener('click', closeAddForm);

/** Save one hand-added title. Returns what the server stored, or throws with a readable message. */
async function putEntry(entry: ManualEntry): Promise<ManualEntry> {
  const res = await fetch(`/api/entries/${entry.malId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `HTTP ${res.status}`);
  }
  const saved = sanitizeEntry(((await res.json()) as { entry?: unknown }).entry);
  if (!saved) throw new Error('The server returned an invalid entry.');
  return saved;
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  refreshAddForm();
  if (!picked || addSubmit.disabled) return;
  const score = typedScore();
  // The date picker gives a day; the time is now, or noon for another day.
  const now = nowLocal();
  const day = addDate.value;
  const added = `${day}T${day === now.slice(0, 10) ? now.slice(11) : '12:00:00'}`;
  const entry = sanitizeEntry({ ...picked, status: addStatus.value, watched: Number(addWatched.value), added });
  if (!entry) return;
  addSubmit.disabled = true;
  setStatus(addStatusLine, 'Adding…');
  try {
    const saved = await putEntry(entry);
    setEntries([...entries.filter((x) => x.malId !== saved.malId), saved]);
    const item = byKey.get(`mal:${saved.malId}`);
    if (item && typeof score === 'number') {
      await putAnnotation(item, { ...current(item), refinedScore: score });
      updateHead(item);
    }
    const title = saved.title;
    closeAddForm();
    setStatus(addSearchStatus, `Added “${title}” to your list.`, 'ok');
  } catch (err) {
    setStatus(addStatusLine, `Not added: ${(err as Error).message}`, 'error');
    addSubmit.disabled = false;
  }
});

/** One row of the "Added by hand" list: status and progress can be changed, the title removed. */
function entryRow(e: ManualEntry, superseded: boolean): HTMLLIElement {
  const li = el('li', 'add-row');
  li.dataset.malId = String(e.malId);
  const text = el('span');
  text.append(
    el('span', 'adm-row__title', e.title),
    el('span', 'adm-row__meta', [e.type, e.year, `added ${e.added.slice(0, 10)}`].filter(Boolean).join(' · ')),
  );
  if (superseded) text.append(el('span', 'add-row__note', 'Now on your OglądajAnime list, so this copy is hidden. You can remove it.'));

  const controls = el('span', 'add-row__controls');
  const status = el('select', 'select');
  status.setAttribute('aria-label', `Status of ${e.title}`);
  for (const s of STATUSES) status.append(new Option(s, s, false, s === e.status));
  const watched = el('input', 'input');
  watched.type = 'number';
  watched.min = '0';
  if (e.total) watched.max = String(e.total);
  watched.value = String(e.watched);
  watched.setAttribute('aria-label', `Episodes watched of ${e.title}`);
  const of = el('span', 'add-row__of', e.total ? `/ ${e.total}` : '/ ?');
  const save = el('button', 'btn btn--primary', 'Save');
  save.type = 'button';
  save.disabled = true;
  const remove = el('button', 'btn adm-danger', 'Remove');
  remove.type = 'button';
  remove.disabled = !canSave;
  const line = el('span', 'adm-status');
  line.setAttribute('role', 'status');

  const read = () => sanitizeEntry({ ...e, status: status.value, watched: Number(watched.value) });
  const changed = () => {
    const n = read();
    const valid = watched.value !== '' && Number.isInteger(Number(watched.value)) && Number(watched.value) >= 0 && (!e.total || Number(watched.value) <= e.total);
    save.disabled = !canSave || !valid || !n || (n.status === e.status && n.watched === e.watched);
  };
  status.addEventListener('change', () => {
    if (status.value === 'Completed' && e.total) watched.value = String(e.total);
    changed();
  });
  watched.addEventListener('input', changed);
  save.addEventListener('click', async () => {
    const next = read();
    if (!next) return;
    save.disabled = true;
    setStatus(line, 'Saving…');
    try {
      const saved = await putEntry(next);
      setEntries(entries.map((x) => (x.malId === saved.malId ? saved : x)));
      setStatus(addSearchStatus, `Saved “${saved.title}”.`, 'ok');
    } catch (err) {
      setStatus(line, `Not saved: ${(err as Error).message}`, 'error');
      changed();
    }
  });
  // Removing asks for a second click instead of opening a dialog. My notes on the title stay.
  let armed: ReturnType<typeof setTimeout> | undefined;
  remove.addEventListener('click', async () => {
    if (armed === undefined) {
      remove.textContent = 'Click again to remove';
      armed = setTimeout(() => {
        armed = undefined;
        remove.textContent = 'Remove';
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = undefined;
    remove.disabled = true;
    setStatus(line, 'Removing…');
    try {
      const res = await fetch(`/api/entries/${e.malId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEntries(entries.filter((x) => x.malId !== e.malId));
      setStatus(addSearchStatus, `Removed “${e.title}”. Your notes on it are kept.`, 'ok');
    } catch (err) {
      setStatus(line, `Not removed: ${(err as Error).message}`, 'error');
      remove.disabled = false;
      remove.textContent = 'Remove';
    }
  });
  controls.append(status, watched, of, save, remove, line);
  li.append(thumbFor(e), text, controls);
  return li;
}

function renderAddList(): void {
  const superseded = supersededEntries(baseItems, entries);
  const sorted = [...entries].sort((a, b) => b.added.localeCompare(a.added) || a.title.localeCompare(b.title));
  addList.replaceChildren(...sorted.map((e) => entryRow(e, superseded.has(e.malId))));
  $('add-none').hidden = entries.length > 0;
}

/** Take a new set of hand-added titles: rebuild the merged list and every view that shows it. */
function setEntries(next: ManualEntry[]): void {
  entries = next;
  items = mergeEntries(baseItems, entries);
  byKey = new Map(items.map((i) => [i.key, i]));
  for (const [key, row] of rows) {
    const item = byKey.get(key);
    // Hand-added rows are rebuilt so they show the new status and progress.
    if (!item || item.manual) {
      row.remove();
      rows.delete(key);
    }
  }
  for (const item of items) {
    if (rows.has(item.key)) continue;
    rows.set(item.key, buildRow(item));
    updateHead(item);
  }
  applyFilter();
  renderAddList();
  if (touched.size === 0) loadGroups();
}

renderAddList();
