import type { AnimeType, MatchConfidence } from '../../src/lib/types';

/** The parts of a MAL (Jikan) or AniList entry the matcher looks at. */
export interface Candidate {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_synonyms?: string[] | null;
  titles?: { type: string; title: string }[] | null;
  type?: string | null;
  episodes?: number | null;
  members?: number | null;
  /** Year it started airing. */
  year?: number | null;
}

export interface MatchResult {
  malId: number | null;
  confidence: MatchConfidence;
  /** 0–1 similarity of the winning candidate. */
  score: number;
  matchedTitle: string | null;
  /** Best different candidate, shown in the report so a wrong pick is easy to spot. */
  runnerUp: { malId: number; title: string; score: number } | null;
}

export interface MatchOptions {
  /**
   * Treat TV / ONA and OVA / Special / ONA as the same kind of thing. AniList files
   * many shows under a different format than MAL does, so its types are only a hint.
   */
  lenientTypes?: boolean;
}

const ROMAN: Record<string, number> = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8 };
const ORDINAL_WORDS: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, final: 99 };

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Remove catalogue decorations that are not part of the name: "(TV)", a year in
 * parentheses, square brackets. The year is returned separately as a hint.
 * "Jujutsu Kaisen (TV)" → "Jujutsu Kaisen"; "Sugar Apple Fairy Tale (2023)" → year 2023.
 */
export function cleanTitle(title: string): { title: string; year: number | null } {
  const yearMatch = /\((19|20)\d{2}\)/.exec(title);
  const cleaned = title
    .replace(/\((?:19|20)\d{2}\)/g, ' ')
    .replace(/\(TV\)/gi, ' ')
    .replace(/[[\]]/g, ' ')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { title: cleaned || title.trim(), year: yearMatch ? Number(yearMatch[0].slice(1, 5)) : null };
}

export interface SequelSignature {
  /** Season number; 1 when the title names none. */
  season: number;
  /** Part / cour number within a season; 1 when the title names none. */
  part: number;
}

/**
 * Work out which instalment a title refers to, so that "Akatsuki no Yona" and
 * "Akatsuki no Yona Season 2" never match each other. Understands
 * "Season 2", "2nd Season", "Second Season", "II", "Part 2", "Cour 2", "(2 Cour)"
 * and a bare number after the name ("Xian Wang de Richang Shenghuo 4", "Nanatsu no Taizai 3: …").
 */
export function sequelSignature(title: string): SequelSignature {
  const t = normalizeTitle(title);
  let season = 1;
  let part = 1;

  const seasonMatch =
    /\b(\d{1,2})(?:st|nd|rd|th) season\b/.exec(t) ?? /\bseason (\d{1,2})\b/.exec(t) ?? /\bs(\d{1,2})$/.exec(t);
  if (seasonMatch) season = Number(seasonMatch[1]);
  else {
    const word = /\b(second|third|fourth|fifth|final) season\b/.exec(t);
    if (word) season = ORDINAL_WORDS[word[1]!]!;
  }

  const partMatch =
    /\b(?:part|cour) (\d{1,2})\b/.exec(t) ??
    /\b(\d{1,2})(?:st|nd|rd|th) (?:part|cour)\b/.exec(t) ??
    /\b(\d{1,2}) cour\b/.exec(t);
  if (partMatch) part = Number(partMatch[1]);

  const tokens = t.split(' ');
  if (!seasonMatch && season === 1) {
    // Roman numeral as a standalone token: "Mob Psycho 100 II", "Overlord IV".
    const romanToken = tokens.slice(1).find((tok) => tok in ROMAN);
    if (romanToken) season = ROMAN[romanToken]!;
    else {
      // Bare number 2–9 at the end of the name, or right before a subtitle ("Name 3: Subtitle").
      const base = t.replace(/\b(?:part|cour) \d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)? (?:part|cour)\b/g, '').trim();
      const trailing = /^.+ ([2-9])$/.exec(base) ?? /^[^:]+ ([2-9]):/.exec(title.toLowerCase());
      if (trailing) season = Number(trailing[1]);
    }
  }
  return { season, part };
}

/**
 * The title without its season / part markers:
 * "Akatsuki no Yona Season 2" → "Akatsuki no Yona", "Shingeki no Kyojin 4: The Final Season Part 2" → "Shingeki no Kyojin".
 */
export function stripSequel(title: string): string {
  const tidy = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/[\s:,-]+$/, '')
      .trim();
  let s = title
    .replace(/\((?:\d+\s*)?cour(?:\s*\d+)?\)/gi, ' ')
    .replace(/\b(?:the\s+)?final\s+season\b/gi, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+(?:season|cour|part)\b/gi, ' ')
    .replace(/\b(?:second|third|fourth|fifth)\s+season\b/gi, ' ')
    .replace(/\b(?:season|part|cour)\s+\d{1,2}\b/gi, ' ')
    .replace(/\s+(?:II|III|IV|V|VI)(?=\s*$|\s*[:(])/g, ' ');
  s = tidy(s);
  s = tidy(s.replace(/\s+[2-9]$/, ''));
  return s.length >= 3 ? s : title.trim();
}

/** Like stripSequel, but null when the title has no sequel marker to strip. */
export function baseTitle(title: string): string | null {
  const stripped = stripSequel(title);
  return stripped.length < title.trim().length ? stripped : null;
}

/** Sørensen–Dice coefficient over character bigrams of two normalized strings. */
export function diceSimilarity(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const TYPE_GROUPS: Record<string, string[]> = {
  tv: ['tv'],
  movie: ['movie'],
  ova: ['short'],
  ona: ['ona'],
  special: ['short'],
  'tv special': ['short'],
};
// Strict: OVA and Special are interchangeable (a "Special" on one site is often an "OVA" on another).
const STRICT_TYPE_GROUPS: Record<string, string[]> = { ...TYPE_GROUPS };
// Lenient: an ONA may also stand for a TV series or a short extra.
const LENIENT_TYPE_GROUPS: Record<string, string[]> = { ...TYPE_GROUPS, ona: ['tv', 'short'] };

export function typesAgree(oaType: AnimeType, malType: string | null | undefined, lenient = false): boolean {
  if (oaType === 'Unknown' || !malType) return true;
  const groups = lenient ? LENIENT_TYPE_GROUPS : STRICT_TYPE_GROUPS;
  const a = groups[oaType.toLowerCase()];
  const b = groups[malType.toLowerCase()];
  if (!a || !b) return false;
  return a.some((g) => b.includes(g));
}

/** Jikan `type` query value for an OA type, or null when there is no clean mapping. */
export function jikanTypeParam(oaType: AnimeType): string | null {
  return oaType === 'Unknown' ? null : oaType.toLowerCase();
}

/** Titles a candidate is known by, with a small weight so the main title wins ties. */
function candidateTitles(c: Candidate): { title: string; weight: number }[] {
  const out: { title: string; weight: number }[] = [{ title: c.title, weight: 1 }];
  if (c.title_english) out.push({ title: c.title_english, weight: 0.99 });
  for (const s of c.title_synonyms ?? []) out.push({ title: s, weight: 0.97 });
  for (const t of c.titles ?? []) {
    if (t.type === 'Default' || t.type === 'Japanese') continue;
    out.push({ title: t.title, weight: t.type === 'English' ? 0.99 : 0.97 });
  }
  return out;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  matchedTitle: string;
  /** A title is identical once punctuation and catalogue decorations are ignored. */
  exactTitle: boolean;
  typeOk: boolean;
  /** The OA title names a year and this candidate started in a different one. */
  yearMismatch: boolean;
  /** Secondary evidence used to break ties: identical spelling, matching year, matching episode count. */
  tiebreak: number;
}

/** Same name and same instalment, written differently ("… 2nd Season" vs "… 2"). */
const EQUIVALENT_SEQUEL_SCORE = 0.97;

/** Score one candidate against an OA title. Pure; exported for tests. */
export function scoreCandidate(
  oaTitle: string,
  oaType: AnimeType,
  oaTotal: number | null,
  c: Candidate,
  options: MatchOptions = {},
): ScoredCandidate {
  const oa = cleanTitle(oaTitle);
  const normOa = normalizeTitle(oa.title);
  const sigOa = sequelSignature(oa.title);
  const baseOa = normalizeTitle(stripSequel(oa.title));
  const typeOk = typesAgree(oaType, c.type, options.lenientTypes);

  let best = { score: -1, title: c.title, exact: false };
  for (const { title, weight } of candidateTitles(c)) {
    const cleaned = cleanTitle(title).title;
    const norm = normalizeTitle(cleaned);
    if (!norm) continue;
    const exact = norm === normOa;
    let s = diceSimilarity(normOa, norm) * weight;
    if (!exact) {
      const sig = sequelSignature(cleaned);
      if (sig.season !== sigOa.season) s *= 0.55; // a different season is a different anime
      else if (sig.part !== sigOa.part) s *= 0.7;
      else if (normalizeTitle(stripSequel(cleaned)) === baseOa) s = Math.max(s, EQUIVALENT_SEQUEL_SCORE * weight);
    }
    if (s > best.score) best = { score: s, title, exact };
  }

  let score = best.score;
  if (!typeOk) score -= 0.1;
  const yearKnown = oa.year !== null && typeof c.year === 'number';
  const yearMismatch = yearKnown && c.year !== oa.year;
  if (yearMismatch) score *= 0.9;

  const sameSpelling = oaTitle.trim().toLowerCase() === c.title.trim().toLowerCase();
  const tiebreak =
    (sameSpelling ? 4 : 0) + (yearKnown && !yearMismatch ? 2 : 0) + (oaTotal !== null && c.episodes === oaTotal ? 1 : 0);

  return {
    candidate: c,
    score: Math.max(0, Math.min(1, score)),
    matchedTitle: best.title,
    exactTitle: best.exact,
    typeOk,
    yearMismatch,
    tiebreak,
  };
}

export const HIGH_CONFIDENCE = 0.9;
export const MIN_MATCH = 0.55;
/** A runner-up this close to the winner, with no weaker secondary evidence, makes the match ambiguous. */
const AMBIGUITY_MARGIN = 0.03;

/**
 * Pick the best candidate for an OA title.
 * - exact: a title is identical after normalization and the type agrees
 * - high:  similarity ≥ 0.9, type agrees, and no other candidate is nearly as good
 * - low:   a plausible match that needs a human look (listed in data/unmatched.md)
 * - none:  nothing plausible
 */
export function pickBestMatch(
  oaTitle: string,
  oaType: AnimeType,
  oaTotal: number | null,
  candidates: Candidate[],
  options: MatchOptions = {},
): MatchResult {
  const seen = new Set<number>();
  const scored = candidates
    .filter((c) => (seen.has(c.mal_id) ? false : (seen.add(c.mal_id), true)))
    .map((c) => scoreCandidate(oaTitle, oaType, oaTotal, c, options))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.tiebreak - a.tiebreak ||
        Number(b.exactTitle) - Number(a.exactTitle) ||
        (b.candidate.members ?? 0) - (a.candidate.members ?? 0),
    );

  const top = scored[0];
  if (!top || top.score < MIN_MATCH) {
    return { malId: null, confidence: 'none', score: round(top?.score ?? 0), matchedTitle: null, runnerUp: null };
  }
  const second = scored[1];
  const runnerUp = second
    ? { malId: second.candidate.mal_id, title: second.candidate.title, score: round(second.score) }
    : null;
  const ambiguous =
    second !== undefined && top.score - second.score < AMBIGUITY_MARGIN && top.tiebreak <= second.tiebreak;

  let confidence: MatchConfidence;
  if (ambiguous || !top.typeOk || top.yearMismatch) confidence = 'low';
  else if (top.exactTitle) confidence = 'exact';
  else if (top.score >= HIGH_CONFIDENCE) confidence = 'high';
  else confidence = 'low';

  return {
    malId: top.candidate.mal_id,
    confidence,
    score: round(top.score),
    matchedTitle: top.matchedTitle,
    runnerUp,
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Cut an over-long search query at a word boundary (search engines reject or mishandle very long queries). */
export function shortenQuery(title: string, max = 60): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s:,-]+$/, '');
}

/**
 * Progressively looser search queries for one title, most specific first, without repeats.
 * Used with sources whose search is picky about long or decorated titles.
 */
export function searchQueries(title: string): string[] {
  const cleaned = cleanTitle(title).title;
  const base = stripSequel(cleaned);
  const words = base.split(' ').filter(Boolean);
  const candidates = [
    shortenQuery(cleaned, 60),
    shortenQuery(base, 40),
    words.length > 3 ? words.slice(0, 3).join(' ') : '',
    words.length > 4 ? words.slice(-3).join(' ') : '',
  ].map((q) => q.replace(/[\s:,-]+$/, '').trim());
  return [...new Set(candidates.filter((q) => q.length >= 3))];
}

/** Cache key for a title + type pair (survives slug changes and CSV-only rows). */
export function matchKey(title: string, type: AnimeType): string {
  return `${normalizeTitle(title)}|${type}`;
}
