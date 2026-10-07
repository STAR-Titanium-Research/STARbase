-- migrate:up
-- Genealogy functions visit each sample once (plan 2026-10-06-axis-map-and-genealogy, stream R).
--
-- f_trace_ancestors / f_trace_descendants (20260619000014) recursed with UNION ALL and a
-- path-array cycle guard, which enumerates every PATH: a diamond lattice of N generations has
-- about 2^N paths, and a 24-level ladder ran for over two minutes with over 10 GB of temp
-- files. Every caller wants the samples, not the paths.
--
-- Same signature and output columns, but now a breadth-first walk with a visited set: one row
-- per reachable sample, at its minimum depth, with one shortest path and the
-- relationship_type / fraction of the edge that reached it on that path. On equal-length routes,
-- the step before each sample is the lowest sample_id among the samples one level nearer that
-- link to it (sample_genealogy_pair_unique allows one edge per pair).
-- Cycles are harmless (a visited sample is never entered again). The functions stay STABLE and
-- are plain (not SECURITY DEFINER); LANGUAGE changes from sql to plpgsql for the loop. The
-- EXECUTE grants from 20260619000015 survive CREATE OR REPLACE, so none are repeated here.
--
-- f_trace_stock_origins calls f_trace_ancestors and so now gets one row per (ancestor, lot)
-- instead of one per path; f_sample_timeline does not touch genealogy. Neither needs changing.

-- ---------------------------------------------------------------------------
-- f_trace_ancestors(sample) — walk child → parent to the roots.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION f_trace_ancestors(p_sample_id UUID)
    RETURNS TABLE (
        depth             INTEGER,
        sample_id         UUID,
        sample_code       TEXT,
        form              TEXT,
        relationship_type TEXT,
        fraction          NUMERIC,
        path              UUID []
    )
    LANGUAGE plpgsql
    STABLE
AS $$
#variable_conflict use_column
DECLARE
    -- The walk so far, one array element per visited sample, in discovery order
    -- (breadth-first: all of depth d sit together, after all of depth d-1).
    n_ids    UUID []    := ARRAY[p_sample_id];
    n_prev   INTEGER [] := ARRAY[0];  -- index in n_ids of the step before; 0 = the start
    n_rel    TEXT []    := ARRAY[NULL::TEXT];
    n_frac   NUMERIC [] := ARRAY[NULL::NUMERIC];
    -- New samples found from the current frontier (n_ids[lo:hi]).
    l_ids    UUID [];
    l_prev   INTEGER [];
    l_rel    TEXT [];
    l_frac   NUMERIC [];
    lo       INTEGER := 1;
    hi       INTEGER := 1;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM physical_samples AS ps WHERE ps.sample_id = p_sample_id) THEN
        RETURN;
    END IF;

    LOOP
        -- One row per not-yet-visited sample reached from the frontier. If several frontier
        -- samples lead to it, the lowest frontier sample_id wins, so the result does not depend
        -- on plan or row order.
        SELECT
            array_agg(c.sid ORDER BY c.sid),
            array_agg(c.prev_idx ORDER BY c.sid),
            array_agg(c.rel ORDER BY c.sid),
            array_agg(c.frac ORDER BY c.sid)
        INTO l_ids, l_prev, l_rel, l_frac
        FROM (
            SELECT DISTINCT ON (sg.parent_sample_id)
                sg.parent_sample_id       AS sid,
                (lo - 1 + f.ord)::INTEGER AS prev_idx,
                sg.relationship_type      AS rel,
                sg.fraction               AS frac
            FROM unnest(n_ids[lo:hi]) WITH ORDINALITY AS f (fid, ord)
            INNER JOIN sample_genealogy AS sg ON sg.child_sample_id = f.fid
            WHERE NOT EXISTS (
                SELECT 1 FROM unnest(n_ids) AS v (vid) WHERE v.vid = sg.parent_sample_id
            )
            ORDER BY sg.parent_sample_id, f.fid
        ) AS c;

        EXIT WHEN l_ids IS NULL;

        lo      := hi + 1;
        n_ids   := n_ids || l_ids;
        n_prev  := n_prev || l_prev;
        n_rel   := n_rel || l_rel;
        n_frac  := n_frac || l_frac;
        hi      := cardinality(n_ids);
    END LOOP;

    -- Every visited sample has exactly one predecessor, so the walk is a tree and the paths are
    -- built top-down in one pass (no path enumeration).
    RETURN QUERY
    WITH RECURSIVE nodes AS (
        SELECT u.sid, u.prev_idx, u.rel, u.frac, u.ord
        FROM unnest(n_ids, n_prev, n_rel, n_frac)
            WITH ORDINALITY AS u (sid, prev_idx, rel, frac, ord)
    ),

    tree AS (
        SELECT n.ord, n.sid, 0 AS dep, n.rel, n.frac, ARRAY[n.sid] AS tpath
        FROM nodes AS n
        WHERE n.prev_idx = 0

        UNION ALL

        SELECT n.ord, n.sid, tree.dep + 1, n.rel, n.frac, tree.tpath || n.sid
        FROM tree
        INNER JOIN nodes AS n ON n.prev_idx = tree.ord
    )

    SELECT
        t.dep,
        ps.sample_id,
        ps.sample_code::TEXT,
        ps.form,
        t.rel,
        t.frac,
        t.tpath
    FROM tree AS t
    INNER JOIN physical_samples AS ps ON ps.sample_id = t.sid
    ORDER BY t.dep, ps.sample_id;
END;
$$;

COMMENT ON FUNCTION f_trace_ancestors(UUID)
    IS 'Reverse traceability: every ancestor of a sample, once (depth 0 = the sample'
       ' itself), walking child→parent through sample_genealogy. Breadth-first: each'
       ' sample appears at its minimum depth with one shortest path and the'
       ' relationship_type/fraction of the edge that reached it (on equal-length routes the'
       ' step before each sample is the lowest linked sample_id one level nearer). Cycle-safe.';

-- ---------------------------------------------------------------------------
-- f_trace_descendants(sample) — walk parent → child to the leaves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION f_trace_descendants(p_sample_id UUID)
    RETURNS TABLE (
        depth             INTEGER,
        sample_id         UUID,
        sample_code       TEXT,
        form              TEXT,
        relationship_type TEXT,
        fraction          NUMERIC,
        path              UUID []
    )
    LANGUAGE plpgsql
    STABLE
AS $$
#variable_conflict use_column
DECLARE
    -- See f_trace_ancestors: the same walk, in the other direction.
    n_ids    UUID []    := ARRAY[p_sample_id];
    n_prev   INTEGER [] := ARRAY[0];
    n_rel    TEXT []    := ARRAY[NULL::TEXT];
    n_frac   NUMERIC [] := ARRAY[NULL::NUMERIC];
    l_ids    UUID [];
    l_prev   INTEGER [];
    l_rel    TEXT [];
    l_frac   NUMERIC [];
    lo       INTEGER := 1;
    hi       INTEGER := 1;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM physical_samples AS ps WHERE ps.sample_id = p_sample_id) THEN
        RETURN;
    END IF;

    LOOP
        SELECT
            array_agg(c.sid ORDER BY c.sid),
            array_agg(c.prev_idx ORDER BY c.sid),
            array_agg(c.rel ORDER BY c.sid),
            array_agg(c.frac ORDER BY c.sid)
        INTO l_ids, l_prev, l_rel, l_frac
        FROM (
            SELECT DISTINCT ON (sg.child_sample_id)
                sg.child_sample_id        AS sid,
                (lo - 1 + f.ord)::INTEGER AS prev_idx,
                sg.relationship_type      AS rel,
                sg.fraction               AS frac
            FROM unnest(n_ids[lo:hi]) WITH ORDINALITY AS f (fid, ord)
            INNER JOIN sample_genealogy AS sg ON sg.parent_sample_id = f.fid
            WHERE NOT EXISTS (
                SELECT 1 FROM unnest(n_ids) AS v (vid) WHERE v.vid = sg.child_sample_id
            )
            ORDER BY sg.child_sample_id, f.fid
        ) AS c;

        EXIT WHEN l_ids IS NULL;

        lo      := hi + 1;
        n_ids   := n_ids || l_ids;
        n_prev  := n_prev || l_prev;
        n_rel   := n_rel || l_rel;
        n_frac  := n_frac || l_frac;
        hi      := cardinality(n_ids);
    END LOOP;

    RETURN QUERY
    WITH RECURSIVE nodes AS (
        SELECT u.sid, u.prev_idx, u.rel, u.frac, u.ord
        FROM unnest(n_ids, n_prev, n_rel, n_frac)
            WITH ORDINALITY AS u (sid, prev_idx, rel, frac, ord)
    ),

    tree AS (
        SELECT n.ord, n.sid, 0 AS dep, n.rel, n.frac, ARRAY[n.sid] AS tpath
        FROM nodes AS n
        WHERE n.prev_idx = 0

        UNION ALL

        SELECT n.ord, n.sid, tree.dep + 1, n.rel, n.frac, tree.tpath || n.sid
        FROM tree
        INNER JOIN nodes AS n ON n.prev_idx = tree.ord
    )

    SELECT
        t.dep,
        ps.sample_id,
        ps.sample_code::TEXT,
        ps.form,
        t.rel,
        t.frac,
        t.tpath
    FROM tree AS t
    INNER JOIN physical_samples AS ps ON ps.sample_id = t.sid
    ORDER BY t.dep, ps.sample_id;
END;
$$;

COMMENT ON FUNCTION f_trace_descendants(UUID)
    IS 'Forward traceability: every descendant of a sample, once (depth 0 = the sample'
       ' itself), walking parent→child through sample_genealogy. Breadth-first: each'
       ' sample appears at its minimum depth with one shortest path and the'
       ' relationship_type/fraction of the edge that reached it (on equal-length routes the'
       ' step before each sample is the lowest linked sample_id one level nearer). Cycle-safe.';

-- migrate:down
-- Restores the path-enumerating definitions from 20260619000014 verbatim.

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION f_trace_ancestors(p_sample_id UUID)
    RETURNS TABLE (
        depth             INTEGER,
        sample_id         UUID,
        sample_code       TEXT,
        form              TEXT,
        relationship_type TEXT,
        fraction          NUMERIC,
        path              UUID []
    )
    LANGUAGE sql
    STABLE
AS $$
    WITH RECURSIVE up AS (
        SELECT
            0                       AS depth,
            ps.sample_id,
            ps.sample_code::TEXT    AS sample_code,
            ps.form,
            NULL::TEXT              AS relationship_type,
            NULL::NUMERIC           AS fraction,
            ARRAY[ps.sample_id]     AS path
        FROM physical_samples AS ps
        WHERE ps.sample_id = p_sample_id

        UNION ALL

        SELECT
            up.depth + 1,
            parent.sample_id,
            parent.sample_code::TEXT,
            parent.form,
            sg.relationship_type,
            sg.fraction,
            up.path || parent.sample_id
        FROM up
        INNER JOIN sample_genealogy AS sg ON sg.child_sample_id = up.sample_id
        INNER JOIN physical_samples AS parent
            ON parent.sample_id = sg.parent_sample_id
        WHERE NOT (parent.sample_id = ANY (up.path))
    )
    SELECT depth, sample_id, sample_code, form, relationship_type, fraction, path
    FROM up;
$$;

COMMENT ON FUNCTION f_trace_ancestors(UUID)
    IS 'Reverse traceability: every ancestor of a sample (depth 0 = the sample'
       ' itself), walking child→parent through sample_genealogy. Cycle-guarded.';

-- ---------------------------------------------------------------------------
-- f_trace_descendants(sample) — walk parent → child to the leaves.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION f_trace_descendants(p_sample_id UUID)
    RETURNS TABLE (
        depth             INTEGER,
        sample_id         UUID,
        sample_code       TEXT,
        form              TEXT,
        relationship_type TEXT,
        fraction          NUMERIC,
        path              UUID []
    )
    LANGUAGE sql
    STABLE
AS $$
    WITH RECURSIVE down AS (
        SELECT
            0                       AS depth,
            ps.sample_id,
            ps.sample_code::TEXT    AS sample_code,
            ps.form,
            NULL::TEXT              AS relationship_type,
            NULL::NUMERIC           AS fraction,
            ARRAY[ps.sample_id]     AS path
        FROM physical_samples AS ps
        WHERE ps.sample_id = p_sample_id

        UNION ALL

        SELECT
            down.depth + 1,
            child.sample_id,
            child.sample_code::TEXT,
            child.form,
            sg.relationship_type,
            sg.fraction,
            down.path || child.sample_id
        FROM down
        INNER JOIN sample_genealogy AS sg ON sg.parent_sample_id = down.sample_id
        INNER JOIN physical_samples AS child
            ON child.sample_id = sg.child_sample_id
        WHERE NOT (child.sample_id = ANY (down.path))
    )
    SELECT depth, sample_id, sample_code, form, relationship_type, fraction, path
    FROM down;
$$;

COMMENT ON FUNCTION f_trace_descendants(UUID)
    IS 'Forward traceability: every descendant of a sample (depth 0 = the sample'
       ' itself), walking parent→child through sample_genealogy. Cycle-guarded.';
