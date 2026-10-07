-- migrate:up
-- Explorer pages (docs/superpowers/specs/2026-10-06-explorer-pages-design.md): the Home module
-- becomes the first entry of the Directus module bar, and the Data Studio ("content") moves to
-- just after the dashboards, so a user lands on Home and reaches the formatted pages first.
-- Directus has one global module bar, so this orders it for everybody; it cannot hide the Data
-- Studio from a role (that is a non-goal of the spec).
--
-- The bar is a JSON array of {type, id, enabled}, as in 20260711000090_fast_module_bar.sql:
--   * home: moved to the front, or added (enabled) when the bar does not list it;
--   * content: moved to just after the last of the three dashboards that is listed; left where it
--     is when none is listed, and not added when the bar does not list it;
--   * everything else keeps its relative order.
-- An entry with no id is kept where it is; a duplicate home entry is dropped (the first one is
-- kept). A NULL bar (Directus' own default) is left alone. Running it twice changes nothing.

UPDATE directus_settings s
   SET module_bar = (
       WITH cur AS (
           SELECT ord, elem FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
       ),
       dash AS (
           SELECT max(ord) AS last_ord FROM cur
            WHERE elem->>'id' IN ('d1-lab-dashboard', 'd1-force-dashboard', 'd1-fast-dashboard')
       ),
       placed AS (
           -- 0: home first (its existing entry if there is one, else a new enabled one)
           SELECT 0 AS pos,
                  COALESCE((SELECT elem FROM cur WHERE elem->>'id' = 'home' ORDER BY ord LIMIT 1),
                           '{"type":"module","id":"home","enabled":true}'::jsonb) AS elem
           UNION ALL
           SELECT ord * 10, elem FROM cur WHERE COALESCE(elem->>'id', '') NOT IN ('home', 'content')
           UNION ALL
           -- content: five places after the last dashboard (entries sit 10 apart), else unchanged
           SELECT COALESCE(dash.last_ord * 10 + 5, cur.ord * 10), cur.elem
             FROM cur CROSS JOIN dash WHERE cur.elem->>'id' = 'content'
       )
       SELECT jsonb_agg(elem ORDER BY pos) FROM placed
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';

-- migrate:down
-- Undo the reordering: Home leaves the bar and the Data Studio goes back to the front, where
-- scripts/configure_directus.sql had it. For a bar that still has the shipped order this restores
-- the previous array exactly. A bar that listed Home before the up migration (curated in the UI)
-- loses that entry here; add it again under Settings > Appearance.
UPDATE directus_settings s
   SET module_bar = (
       WITH cur AS (
           SELECT ord, elem FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
       ),
       placed AS (
           SELECT 0 AS pos, elem FROM cur WHERE elem->>'id' = 'content'
           UNION ALL
           SELECT ord * 10, elem FROM cur WHERE COALESCE(elem->>'id', '') NOT IN ('home', 'content')
       )
       SELECT jsonb_agg(elem ORDER BY pos) FROM placed
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';
