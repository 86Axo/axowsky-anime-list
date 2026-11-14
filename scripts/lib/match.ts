import type { AnimeType, MatchConfidence } from '../../src/lib/types';

/** The parts of a Jikan anime object the matcher looks at. */
export interface Candidate {
  mal_id: number;
  title: string;
  title_english?: string | null;
  title_synonyms?: string[] | null;
  titles?: { type: string; title: string }[] | null;
  type?: string | null;
  episodes?: number | null;
  members?: number | null;
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
 * and a bare trailing number ("Xian Wang de Richang Shenghuo 4").
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
      // Bare trailing number 2–9, once any part/cour suffix is removed.
      const base = t.replace(/\b(?:part|cour) \d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)? (?:part|cour)\b/g, '').trim();
      const trailing = /^.+ ([2-9])$/.exec(base);
      if (trailing) season = Number(trailing[1]);
    }
  }
  return { season, part };
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

const TYPE_GROUP: Record<string, string> = {
  tv: 'tv',
  movie: 'movie',
  ova: 'ova',
  ona: 'ona',
  special: 'special',
  'tv special': 'special',
};

export function typesAgree(oaType: AnimeType, malType: string | null | undefined): boolean {
  if (oaType === 'Unknown' || !malType) return true;
  return TYPE_GROUP[oaType.toLowerCase()] === TYPE_GROUP[malType.toLowerCase()];
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
  exactTitle: boolean;
  typeOk: boolean;
}

/** Score one candidate against an OA title. Pure; exported for tests. */
export function scoreCandidate(oaTitle: string, oaType: AnimeType, oaTotal: number | null, c: Candidate): ScoredCandidate {
  const normOa = normalizeTitle(oaTitle);
  const sigOa = sequelSignature(oaTitle);
  const typeOk = typesAgree(oaType, c.type);

  let best = { score: -1, title: c.title, exact: false };
  for (const { title, weight } of candidateTitles(c)) {
    const norm = normalizeTitle(title);
    if (!norm) continue;
    const exact = norm === normOa;
    let s = diceSimilarity(normOa, norm) * weight;
    if (!exact) {
      const sig = sequelSignature(title);
      // A different season or part is a different anime, however similar the words are.
      if (sig.season !== sigOa.season) s *= 0.55;
      else if (sig.part !== sigOa.part) s *= 0.7;
    }
    if (s > best.score) best = { score: s, title, exact };
  }

  let score = best.score;
  if (!typeOk) score -= 0.1;
  if (oaTotal !== null && c.episodes === oaTotal) score += 0.02;
  return {
    candidate: c,
    score: Math.max(0, Math.min(1, score)),
    matchedTitle: best.title,
    exactTitle: best.exact,
    typeOk,
  };
}

export const HIGH_CONFIDENCE = 0.9;
export const MIN_MATCH = 0.55;
/** A runner-up this close to the winner makes the match ambiguous. */
const AMBIGUITY_MARGIN = 0.03;

/**
 * Pick the best MAL candidate for an OA title.
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
): MatchResult {
  const seen = new Set<number>();
  const scored = candidates
    .filter((c) => (seen.has(c.mal_id) ? false : (seen.add(c.mal_id), true)))
    .map((c) => scoreCandidate(oaTitle, oaType, oaTotal, c))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.exactTitle) - Number(a.exactTitle) ||
        (b.candidate.members ?? 0) - (a.candidate.members ?? 0),
    );

  const top = scored[0];
  if (!top || top.score < MIN_MATCH) {
    return { malId: null, confidence: 'none', score: top?.score ?? 0, matchedTitle: null, runnerUp: null };
  }
  const second = scored[1];
  const runnerUp = second
    ? { malId: second.candidate.mal_id, title: second.candidate.title, score: round(second.score) }
    : null;
  const ambiguous = second !== undefined && top.score - second.score < AMBIGUITY_MARGIN;

  let confidence: MatchConfidence;
  if (top.exactTitle && top.typeOk && !(ambiguous && second!.exactTitle && second!.typeOk)) confidence = 'exact';
  else if (top.score >= HIGH_CONFIDENCE && top.typeOk && !ambiguous) confidence = 'high';
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

/** Cut an over-long search query at a word boundary (MAL search rejects very long queries). */
export function shortenQuery(title: string, max = 60): string {
  if (title.length <= max) return title;
  const cut = title.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[\s:,\-–]+$/, '');
}

/** Cache key for a title + type pair (survives slug changes and CSV-only rows). */
export function matchKey(title: string, type: AnimeType): string {
  return `${normalizeTitle(title)}|${type}`;
}
