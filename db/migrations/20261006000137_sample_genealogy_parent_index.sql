-- migrate:up
-- Index sample_genealogy on parent_sample_id (plan 2026-10-06-axis-map-and-genealogy, stream R).
--
-- The child side is covered by sample_genealogy_pair_unique (child_sample_id, parent_sample_id);
-- the parent side had no index, so every level of f_trace_descendants (20261006000136), the
-- d1-trace ancestors edge query and v_sample_genealogy_flat scanned the whole table. Measured on
-- about 168k genealogy rows: a 3000-deep chain's descendants went from 33.9 s to 2.5 s, a 40x50
-- ladder from 572 ms to 146 ms. The table is small, so a plain (transactional) CREATE INDEX is
-- fine.
CREATE INDEX IF NOT EXISTS sample_genealogy_parent_sample_id_idx
    ON sample_genealogy (parent_sample_id);

-- migrate:down
DROP INDEX IF EXISTS sample_genealogy_parent_sample_id_idx;
