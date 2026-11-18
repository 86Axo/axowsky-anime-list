-- The other keys a title is known by (JSON array, normally its "oa:<slug>"). They let notes
-- find their title again if a sync later matches it to a different MAL entry.
ALTER TABLE annotations ADD COLUMN aliases TEXT;
