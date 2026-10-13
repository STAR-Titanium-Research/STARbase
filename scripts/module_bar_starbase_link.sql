-- The module bar's STARbase tile (docs/superpowers/specs/2026-10-13-directus-headless-design.md §5.6).
-- Directus turns a link url that starts with "/" into a route inside /admin (module-bar.vue), so the
-- tile needs the absolute server address: pass it as the psql variable public_url
-- (scripts/set_module_bar_starbase.sh does). The tile goes first, replacing any earlier starbase
-- entry; a NULL bar is left alone. Running it twice changes nothing.
UPDATE directus_settings s
   SET module_bar = (
       SELECT jsonb_build_array(jsonb_build_object(
                  'type', 'link', 'id', 'starbase', 'name', 'STARbase',
                  'url', regexp_replace(:'public_url', '/+$', '') || '/d1-links/go',
                  'icon', 'rocket_launch', 'enabled', true))
              || COALESCE((SELECT jsonb_agg(elem ORDER BY ord)
                             FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(elem, ord)
                            WHERE COALESCE(elem->>'id', '') <> 'starbase'), '[]'::jsonb)
   )::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';
