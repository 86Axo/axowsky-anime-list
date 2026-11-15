/**
 * Finds a picture for a favorite character.
 *
 * This runs in the admin panel, in my own browser: it asks AniList for the cast of
 * the anime (by MAL id), offers the characters to pick from, and matches a typed
 * name to one of them. The chosen picture URL is saved with the annotation, so the
 * public page shows it without any lookup of its own.
 *
 * It cannot run on the server: AniList refuses requests that come from Cloudflare
 * Workers, and that refusal is respected rather than worked around.
 */
export interface CharacterInfo {
  /** Every name the character is known by: full, native, nicknames. */
  names: string[];
  image: string | null;
}

const ENDPOINT = 'https://graphql.anilist.co';

const QUERY = `query ($id: Int, $page: Int) {
  Media(idMal: $id, type: ANIME) {
    characters(page: $page, perPage: 50, sort: [ROLE, RELEVANCE, ID]) {
      pageInfo { hasNextPage }
      nodes { name { full native alternative } image { medium } }
    }
  }
}`;

interface CharactersResponse {
  data?: {
    Media?: {
      characters?: {
        pageInfo?: { hasNextPage?: boolean };
        nodes?: { name?: { full?: string | null; native?: string | null; alternative?: (string | null)[] | null }; image?: { medium?: string | null } }[];
      };
    } | null;
  };
}

/** The cast of an anime, main characters first. Each page holds 50 characters. */
export async function fetchCharacters(malId: number, fetchImpl: typeof fetch = fetch, maxPages = 3): Promise<CharacterInfo[]> {
  const out: CharacterInfo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { id: malId, page } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) break;
    const characters = ((await res.json()) as CharactersResponse).data?.Media?.characters;
    for (const node of characters?.nodes ?? []) {
      const names = [node.name?.full, node.name?.native, ...(node.name?.alternative ?? [])].filter(
        (n): n is string => typeof n === 'string' && n.trim() !== '',
      );
      if (names.length > 0) out.push({ names, image: node.image?.medium ?? null });
    }
    if (!characters?.pageInfo?.hasNextPage) break;
  }
  return out;
}

const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** How well a typed name fits one of a character's names, 0–1. */
function nameScore(query: string, name: string): number {
  const q = fold(query);
  const n = fold(name);
  if (!q || !n) return 0;
  if (q === n) return 1;
  const qt = q.split(' ');
  const nt = n.split(' ');
  const sameSet = qt.length === nt.length && qt.every((t) => nt.includes(t));
  if (sameSet) return 0.98; // "Milize Vladilena" for "Vladilena Milize"
  if (qt.every((t) => nt.includes(t))) return 0.85; // first name or surname only
  if (nt.every((t) => qt.includes(t))) return 0.75; // typed more than the cast list has
  // A single near-miss in spelling, on names long enough for that to mean something.
  if (q.length >= 5 && Math.abs(q.length - n.length) <= 1 && editDistanceAtMostOne(q, n)) return 0.7;
  return 0;
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a.length < b.length) [a, b] = [b, a];
  let i = 0;
  while (i < b.length && a[i] === b[i]) i++;
  return a.length === b.length ? a.slice(i + 1) === b.slice(i + 1) : a.slice(i + 1) === b.slice(i);
}

/** The character a typed name most likely means, or null. Earlier (more central) characters win ties. */
export function pickCharacter(query: string, characters: CharacterInfo[]): CharacterInfo | null {
  let best: CharacterInfo | null = null;
  let bestScore = 0;
  for (const c of characters) {
    const score = Math.max(0, ...c.names.map((n) => nameScore(query, n)));
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore >= 0.7 ? best : null;
}

/** Picture URL for a character of the given anime, or null when it cannot be determined. */
export async function lookupCharacterImage(malId: number, name: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    return pickCharacter(name, await fetchCharacters(malId, fetchImpl))?.image ?? null;
  } catch {
    return null; // a picture is a nicety; saving the annotation must not fail because of it
  }
}
