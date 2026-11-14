import { finalScore } from '../config/rating';
import { isEmptyAnnotation, sanitizeAnnotation, sanitizeAnnotationMap } from '../lib/annotations';
import type { ListItem } from '../lib/model';
import { tierBadge } from '../lib/render';
import type { Annotation, AnnotationMap } from '../lib/types';
import { initThemeToggle } from './theme';

initThemeToggle();

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const banner = $('adm-banner');
const list = $<HTMLUListElement>('adm-list');
const search = $<HTMLInputElement>('adm-search');
const onlyAnnotated = $<HTMLInputElement>('adm-only');
const count = $('adm-count');
const template = $<HTMLTemplateElement>('adm-form');

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

const [data, me, annRes] = await Promise.all([
  getJson<{ items: ListItem[] }>('/data.json'),
  getJson<{ authenticated: boolean; user: string | null; mode: string }>('/api/auth/me'),
  getJson<{ annotations: unknown }>('/api/annotations'),
]);

const items = data?.items ?? [];
const annotations: AnnotationMap = sanitizeAnnotationMap(annRes?.annotations);

if (!me) showBanner('The API is not reachable here (it only runs on Cloudflare Pages or `npm run pages:dev`). Saving is disabled.');
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

/** The key an existing annotation is stored under: the main key, or the OA-slug fallback. */
const storedKey = (item: ListItem): string | null =>
  annotations[item.key] ? item.key : item.altKey && annotations[item.altKey] ? item.altKey : null;
const current = (item: ListItem): Annotation | undefined => {
  const key = storedKey(item);
  return key ? annotations[key] : undefined;
};

function summarize(item: ListItem): string {
  const a = current(item);
  if (!a) return '';
  return [
    a.refinedScore !== null ? `refined ${a.refinedScore}` : '',
    a.tags.length ? `${a.tags.length} tag${a.tags.length > 1 ? 's' : ''}` : '',
    a.review ? 'review' : '',
    a.favoriteCharacter ? `fav: ${a.favoriteCharacter}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const rows = new Map<string, HTMLLIElement>();

function updateSummary(item: ListItem, row: HTMLLIElement): void {
  row.querySelector('.adm-badge')!.innerHTML = tierBadge(finalScore(item.score, current(item)?.refinedScore));
  row.querySelector('.adm-flag')!.textContent = summarize(item);
}

function fillForm(form: HTMLFormElement, item: ListItem): void {
  const a = current(item);
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  const score = field('refinedScore') as HTMLInputElement;
  score.value = a?.refinedScore != null ? String(a.refinedScore) : '';
  score.placeholder = item.score !== null ? `${finalScore(item.score, null)} (from ${item.score}/10)` : 'not rated';
  field('tags').value = a?.tags.join(', ') ?? '';
  field('favoriteCharacter').value = a?.favoriteCharacter ?? '';
  const avatar = form.querySelector<HTMLImageElement>('[data-avatar]')!;
  avatar.hidden = !a?.favoriteCharacterImage;
  if (a?.favoriteCharacterImage) avatar.src = a.favoriteCharacterImage;
  else avatar.removeAttribute('src');
  field('review').value = a?.review ?? '';
}

async function save(item: ListItem, form: HTMLFormElement, clear: boolean): Promise<void> {
  const status = form.querySelector<HTMLElement>('.adm-status')!;
  const fd = new FormData(form);
  const scoreRaw = String(fd.get('refinedScore') ?? '').trim();
  const next = clear
    ? sanitizeAnnotation({})
    : sanitizeAnnotation({
        refinedScore: scoreRaw === '' ? null : Number(scoreRaw),
        tags: String(fd.get('tags') ?? '').split(','),
        favoriteCharacter: fd.get('favoriteCharacter'),
        review: fd.get('review'),
      });
  if (!clear && scoreRaw !== '' && next.refinedScore === null) {
    status.textContent = 'The refined score must be a whole number from 1 to 100.';
    return;
  }
  status.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/annotations/${encodeURIComponent(item.key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // malId lets the server find the character's picture even when the key is an `oa:` one.
      body: JSON.stringify({ ...next, malId: item.malId }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      status.textContent = `Not saved: ${err?.error ?? `HTTP ${res.status}`}`;
      return;
    }
    // An annotation stored under the old OA-slug key moves to the main key.
    const old = storedKey(item);
    if (old && old !== item.key) {
      await fetch(`/api/annotations/${encodeURIComponent(old)}`, { method: 'DELETE' });
      delete annotations[old];
    }
    // Keep what the server stored: it adds the favorite character's picture.
    const saved = sanitizeAnnotation(((await res.json()) as { annotation?: unknown }).annotation);
    if (isEmptyAnnotation(saved)) delete annotations[item.key];
    else annotations[item.key] = saved;
    fillForm(form, item);
    updateSummary(item, rows.get(item.key)!);
    status.textContent = isEmptyAnnotation(saved)
      ? 'Cleared.'
      : saved.favoriteCharacter && !saved.favoriteCharacterImage
        ? 'Saved. No picture found for that character name.'
        : 'Saved.';
    applyFilter();
  } catch {
    status.textContent = 'Not saved: network error.';
  }
}

function buildRow(item: ListItem): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'adm-row';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.className = 'adm-title';
  title.textContent = item.title;
  const meta = document.createElement('span');
  meta.className = 'adm-meta';
  meta.textContent = `${item.status} · ${item.type}`;
  const badge = document.createElement('span');
  badge.className = 'adm-badge';
  const flag = document.createElement('span');
  flag.className = 'adm-flag';
  summary.append(title, meta, badge, flag);
  details.append(summary);
  li.append(details);
  updateSummary(item, li);

  // The form is only built when a row is first opened.
  details.addEventListener('toggle', () => {
    if (!details.open || details.querySelector('form')) return;
    const form = (template.content.cloneNode(true) as DocumentFragment).querySelector('form')!;
    fillForm(form, item);
    if (!canSave) for (const el of form.querySelectorAll<HTMLButtonElement>('button')) el.disabled = true;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void save(item, form, false);
    });
    form.querySelector('[data-clear]')!.addEventListener('click', () => void save(item, form, true));
    details.append(form);
  });
  return li;
}

function applyFilter(): void {
  const tokens = search.value.toLowerCase().split(/\s+/).filter(Boolean);
  let visible = 0;
  for (const item of items) {
    const row = rows.get(item.key)!;
    const hay = `${item.title} ${item.titleEn ?? ''}`.toLowerCase();
    const show = tokens.every((t) => hay.includes(t)) && (!onlyAnnotated.checked || current(item) !== undefined);
    row.hidden = !show;
    if (show) visible++;
  }
  const annotated = items.filter((i) => current(i) !== undefined).length;
  count.textContent = `${visible} shown · ${annotated} annotated`;
}

if (items.length === 0) showBanner('Could not load the list data.');
const fragment = document.createDocumentFragment();
for (const item of [...items].sort((a, b) => a.title.localeCompare(b.title))) {
  const row = buildRow(item);
  rows.set(item.key, row);
  fragment.append(row);
}
list.append(fragment);
search.addEventListener('input', applyFilter);
onlyAnnotated.addEventListener('change', applyFilter);
applyFilter();
