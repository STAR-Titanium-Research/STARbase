-- migrate:up
-- Directus goes headless (docs/superpowers/specs/2026-10-13-directus-headless-design.md §5.6): Home
-- and the Force and FAST plotter modules are gone (STARbase has them), so their module-bar entries
-- go too. Everything else keeps its order. The STARbase link tile needs the absolute server address,
-- which a migration cannot read, so scripts/set_module_bar_starbase.sh adds it. A NULL bar
-- (Directus' own default) is left alone. Running it twice changes nothing.
UPDATE directus_settings s
   SET module_bar = (
       SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
        WHERE COALESCE(elem->>'id', '') NOT IN ('home', 'd1-force-dashboard', 'd1-fast-dashboard')
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';

-- migrate:down
-- Put them back: Home first (after nothing), the two plotters just before the Data Studio
-- ("content"), or at the end when the bar has no content entry. Entries already present are not
-- duplicated.
UPDATE directus_settings s
   SET module_bar = (
       WITH cur AS (
           SELECT ord, elem FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
       ),
       content_at AS (SELECT min(ord) AS o FROM cur WHERE elem->>'id' = 'content'),
       placed AS (
           SELECT 0 AS pos, '{"type":"module","id":"home","enabled":true}'::jsonb AS elem
            WHERE NOT EXISTS (SELECT 1 FROM cur WHERE elem->>'id' = 'home')
           UNION ALL
           SELECT ord * 10, elem FROM cur
           UNION ALL
           SELECT COALESCE((SELECT o FROM content_at) * 10 - 2, 100000), '{"type":"module","id":"d1-force-dashboard","enabled":true}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM cur WHERE elem->>'id' = 'd1-force-dashboard')
           UNION ALL
           SELECT COALESCE((SELECT o FROM content_at) * 10 - 1, 100001), '{"type":"module","id":"d1-fast-dashboard","enabled":true}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM cur WHERE elem->>'id' = 'd1-fast-dashboard')
       )
       SELECT jsonb_agg(elem ORDER BY pos) FROM placed
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';
