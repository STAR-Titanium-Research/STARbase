-- migrate:up
-- D9 (docs/reviews/2026-10-05-ux-utility-review.md): the sample-number PREVIEW in the Register
-- sample page and the d1-sample-code interface read every sample_code through the Directus items
-- API (limit -1) and took the highest leading integer + 1 in the browser. That is O(n) per page
-- load and undercounts for any account whose read permissions hide samples. The number itself is
-- assigned by trg_physical_samples_assign_code_number() (20261003000127); this function exposes
-- the same calculation, so the preview and the real assignment use the same rule.
-- The d1-next-number endpoint extension calls it. It takes no lock and reserves nothing: it is a
-- preview, and the trigger still decides at save time.

CREATE FUNCTION next_sample_code_number(p_exclude_sample_id UUID DEFAULT NULL) RETURNS BIGINT
    LANGUAGE sql STABLE
    SET search_path = pg_catalog, public
AS $$
    SELECT COALESCE(max((substring(ps.sample_code FROM '^(\d{1,9})-'))::bigint), 0) + 1
    FROM   public.physical_samples ps
    WHERE  ps.sample_id IS DISTINCT FROM p_exclude_sample_id;
$$;

COMMENT ON FUNCTION next_sample_code_number(UUID) IS
    'Preview of the next sample number: 1 + the highest leading integer of every sample code, '
    'optionally ignoring one sample (the one being renumbered). Same rule as '
    'trg_physical_samples_assign_code_number(); takes no lock, so the trigger still decides at save time (review D9).';

-- migrate:down
DROP FUNCTION IF EXISTS next_sample_code_number(UUID);
