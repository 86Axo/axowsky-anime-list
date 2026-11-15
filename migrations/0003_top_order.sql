-- Manual position among titles with the same final score (lower comes first). Used by the Top 10.
ALTER TABLE annotations ADD COLUMN top_order INTEGER;
