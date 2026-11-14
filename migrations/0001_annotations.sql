-- Personal annotations, one row per anime.
-- key is `mal:<MAL id>` when the title is matched to MyAnimeList, otherwise `oa:<OglądajAnime slug>`,
-- so notes survive title changes and removals on OglądajAnime.
CREATE TABLE IF NOT EXISTS annotations (
  key                TEXT PRIMARY KEY,
  refined_score      INTEGER CHECK (refined_score IS NULL OR refined_score BETWEEN 1 AND 100),
  review             TEXT,
  tags               TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  favorite_character TEXT,
  updated_at         TEXT NOT NULL
);
