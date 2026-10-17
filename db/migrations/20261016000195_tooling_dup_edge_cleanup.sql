-- migrate:up
-- Tooling: delete duplicate edge rows left by the legacy import. The tooling stage counts an insert's edges ("4/4 fresh"), and an
-- insert with two rows for one letter read 5/5. The app now ignores such duplicates when it draws and counts (toolingModel.ts,
-- dedupeEdges); this removes the unreferenced ones from the data, so the next import or report does not meet them either.
--
-- A duplicate is a second insert_edges row with the same insert_id and the same edge_identifier. Of the rows for one letter the
-- one that is kept is the used one, else the one with the shortest edge_code, else the first by code (so "edb57db7-2598-fD"
-- stays and "edb57db7-2598-fD-7152" goes). A row is deleted only if it is not the keeper, is not used, and nothing anywhere points at
-- it: no manufacturing_operations.insert_edge_id, test_sessions.insert_edge_id or surface_scans.edge_id (the foreign keys to
-- insert_edges(edge_id)), and none of the polymorphic references that carry an edge id without a foreign key (test_sessions_subject,
-- test_sessions.test_code_subject_*, test_code_counters). A duplicate with any reference is left alone. Missing edges are NOT added.
--
-- Rows removed when this was written, against the live database (a dry run in a rolled-back transaction): exactly one,
--   edge_id 10640b9d-9eae-57f5-95e0-33372982bf7b, edge_code edb57db7-2598-fD-7152 (insert 7e58a43b-da93-505e-b84c-fc1c424e24c6,
--   letter fD, unused, no references). Its twin edb57db7-2598-fD is kept.
-- The deletes are audited by audit_insert_edges like any other.

WITH ranked AS (
    SELECT e.edge_id,
           row_number() OVER (
               PARTITION BY e.insert_id, e.edge_identifier
               ORDER BY e.is_used DESC, length(e.edge_code) ASC, e.edge_code ASC, e.edge_id ASC
           ) AS keep_rank
      FROM insert_edges e
)
DELETE FROM insert_edges e
 USING ranked r
 WHERE e.edge_id = r.edge_id
   AND r.keep_rank > 1
   AND NOT e.is_used
   AND NOT EXISTS (SELECT 1 FROM manufacturing_operations x WHERE x.insert_edge_id = e.edge_id)
   AND NOT EXISTS (SELECT 1 FROM test_sessions x WHERE x.insert_edge_id = e.edge_id)
   AND NOT EXISTS (SELECT 1 FROM surface_scans x WHERE x.edge_id = e.edge_id)
   AND NOT EXISTS (SELECT 1 FROM test_sessions_subject x WHERE x.collection = 'insert_edges' AND lower(x.item) = lower(e.edge_id::text))
   AND NOT EXISTS (SELECT 1 FROM test_sessions x WHERE x.test_code_subject_collection = 'insert_edges' AND x.test_code_subject_id = e.edge_id)
   AND NOT EXISTS (SELECT 1 FROM test_code_counters x WHERE x.subject_collection = 'insert_edges' AND x.subject_id = e.edge_id);

-- migrate:down
-- Nothing to restore: the rows this migration deleted were unused, unreferenced duplicates of an edge that is kept (see the up header
-- for the one row removed on the live database, edge_code edb57db7-2598-fD-7152). They are not recreated, and recreating them would
-- bring back the 5/5 count. Their old values are in the audit log (audit_insert_edges) if anyone needs them.
SELECT 1;
