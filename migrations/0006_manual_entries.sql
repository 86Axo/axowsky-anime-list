-- Titles added by hand in the admin panel (anime that are not on my OglądajAnime list).
-- data is the whole entry as JSON (see src/lib/entries.ts); it is validated on every write.
CREATE TABLE IF NOT EXISTS manual_entries (
  mal_id     INTEGER PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
