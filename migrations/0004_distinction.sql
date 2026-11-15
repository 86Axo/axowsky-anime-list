-- A short label for a title that earned a special mention without being a top score
-- (for example "Best soundtrack"). NULL = no distinction.
ALTER TABLE annotations ADD COLUMN distinction TEXT;
