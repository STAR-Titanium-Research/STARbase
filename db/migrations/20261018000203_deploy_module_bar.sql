-- migrate:up
-- Deploy button (docs/superpowers/specs/2026-10-18-deploy-button-design.md): puts the "Deploy" module
-- (core/extensions/d1-deploy, admin-only through its preRegisterCheck) at the end of the Directus
-- module bar. A new module is not shown until the global bar lists it as enabled.
-- The bar is a JSON array of {type, id, enabled}, as in 20260711000090_fast_module_bar.sql. An existing
-- d1-deploy entry is left as it is (so a hidden one stays hidden); a NULL bar (Directus' own default)
-- is left alone. Running it twice changes nothing.

UPDATE directus_settings s
   SET module_bar = (s.module_bar::jsonb || '[{"type":"module","id":"d1-deploy","enabled":true}]'::jsonb)::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array'
   AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(s.module_bar::jsonb) AS e WHERE e->>'id' = 'd1-deploy'
   );

-- migrate:down
-- Remove the Deploy module from the bar.
UPDATE directus_settings s
   SET module_bar = COALESCE((
       SELECT jsonb_agg(e ORDER BY ord)
         FROM jsonb_array_elements(s.module_bar::jsonb) WITH ORDINALITY AS t(e, ord)
        WHERE COALESCE(e->>'id', '') <> 'd1-deploy'
   ), '[]'::jsonb)::json
 WHERE s.module_bar IS NOT NULL
   AND jsonb_typeof(s.module_bar::jsonb) = 'array';
