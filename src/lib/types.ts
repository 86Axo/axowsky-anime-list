export const STATUSES = ['Watching', 'Completed', 'On Hold', 'Dropped', 'Plan to Watch'] as const;
export type Status = (typeof STATUSES)[number];

export const ANIME_TYPES = ['TV', 'Movie', 'OVA', 'ONA', 'Special', 'Unknown'] as const;
export type AnimeType = (typeof ANIME_TYPES)[number];

/** One row of my OglądajAnime list, normalized. Comes from the CSV export or the public list HTML. */
export interface OaEntry {
  /** OA numeric anime id. Only known from the list HTML. */
  oaId: number | null;
  /** OA slug. Only known from the list HTML. Never used to fetch OA anime pages. */
  slug: string | null;
  title: string;
  status: Status;
  /** Original Polish status label, kept for debugging and the report. */
  rawStatus: string;
  /** 1–10, or null when not rated. */
  score: number | null;
  watched: number;
  /** null when OA does not know the episode count (shown as x/0). */
  total: number | null;
  type: AnimeType;
  /** Naive local timestamp `YYYY-MM-DDTHH:MM:SS`. Only known from the list HTML. */
  addedAt: string | null;
}

export interface MalInfo {
  id: number;
  url: string;
  title: string;
  titleEnglish: string | null;
  titleJapanese: string | null;
  /** ~225px wide cover (WebP). */
  image: string | null;
  /** ~425px wide cover (WebP). */
  imageLarge: string | null;
  type: string | null;
  episodes: number | null;
  durationMin: number | null;
  airStatus: string | null;
  airing: boolean;
  season: string | null;
  year: number | null;
  score: number | null;
  genres: string[];
  themes: string[];
  demographics: string[];
  studios: string[];
  /** Present when this came from the AniList backup because Jikan was down. Absent means MyAnimeList data. */
  source?: 'anilist';
}

export type MatchConfidence = 'override' | 'exact' | 'high' | 'low' | 'none';

export interface AnimeEntry extends OaEntry {
  /** Stable annotation key: `mal:<id>`, else `oa:<slug>`, else `title:<normalized>`. */
  key: string;
  mal: MalInfo | null;
  match: { confidence: MatchConfidence; score: number };
}

export interface Dataset {
  version: 1;
  entries: AnimeEntry[];
}

/** Personal annotation stored in D1, keyed by AnimeEntry.key. */
export interface Annotation {
  refinedScore: number | null;
  review: string | null;
  tags: string[];
  favoriteCharacter: string | null;
  /** Picture of the favorite character, looked up by the write API. Never set by hand. */
  favoriteCharacterImage: string | null;
  /** Manual position among titles with the same final score; lower comes first. Decides ties in the Top 10. */
  topOrder: number | null;
  /** A highlighted title: singled out on the page with a quieter version of the S+ look. */
  highlight: boolean;
  /**
   * The title's other keys (its `oa:<slug>`). They let the notes find their title again
   * if a later sync matches it to a different MAL entry.
   */
  aliases: string[];
  updatedAt?: string;
}
export type AnnotationMap = Record<string, Annotation>;
