-- migrate:up
-- Move the legacy "rig kit" rows out of physical_samples and into equipment. The AppSheet import (Phase 8) put the STAR FRM kit
-- (Kistler Dyno, cable, case, tool holder, Peli cases, Wera tools, shims, boxes...) in physical_samples with a hex short code as the
-- sample_code ("4ba65a07 Kistler Tool Holder"). They are not samples, but the Samples index lists every physical_samples row, so the
-- hex codes polluted it. 16 of them were already item_type = 'equipment'/'miscellaneous'; "Insert boxes" (ff982876) was still 'sample'.
--
-- A row is moved when its sample_code is exactly 8 lowercase hex characters (the import's short-id style; real samples are numbered
-- or named, e.g. 164-167-F1E-MS-2026-10-15, DEMO-TI64-001) AND nothing points at it: no operations, tests, genealogy, campaign links,
-- data files, access/co-owner rows, stock provenance, or polymorphic test subjects. A hex-coded row with any reference is left alone
-- (and is still deleted-safe: the FKs from those tables cascade, so the guard is what protects them).
--
-- The new equipment row keeps the name (nickname), notes (with "Was sample <code>." appended), location and project. equipment_code is
-- the name slugged the way the lab-equipment import did it (non-alphanumerics -> '-'), with the old hex code appended if that collides.
-- equipment_type is the new 'Rig_Kit' ("Rig kit / accessory"): equipment_type is a free-text column with an allowOther dropdown, so the
-- value needs no schema change, only a label (choiceLabels.ts in d1-ui and d1-report) and a choice in the Directus field options.
--
-- Rows moved when this was written, against the live database (read-only check): 17 (16 item_type 'equipment', 1 'sample'), none
-- referenced. The deletes and inserts are audited by audit_physical_samples / audit_equipment like any other.

-- 1. The dropdown choice (kept in alphabetical position by label).
UPDATE directus_fields
   SET options = jsonb_set(
         options::jsonb, '{choices}',
         (SELECT jsonb_agg(c ORDER BY lower(c->>'text'))
            FROM jsonb_array_elements((options::jsonb)->'choices' || '[{"text":"Rig kit / accessory","value":"Rig_Kit"}]'::jsonb) c)
       )::json
 WHERE collection = 'equipment' AND field = 'equipment_type'
   AND NOT ((options::jsonb)->'choices') @> '[{"value":"Rig_Kit"}]'::jsonb;

-- 2. Copy the unreferenced hex-coded rows into equipment, then remove them from physical_samples.
CREATE TEMP TABLE _rig_kit ON COMMIT DROP AS
SELECT p.sample_id, p.sample_code, p.notes, p.location, p.project_id,
       COALESCE(NULLIF(btrim(p.nickname), ''), p.sample_code) AS item_name
  FROM physical_samples p
 WHERE p.sample_code ~ '^[0-9a-f]{8}$'
   AND NOT EXISTS (SELECT 1 FROM manufacturing_operations x WHERE x.sample_id = p.sample_id OR x.output_sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM test_sessions x WHERE x.sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM test_sessions_subject x WHERE x.collection = 'physical_samples' AND lower(x.item) = lower(p.sample_id::text))
   AND NOT EXISTS (SELECT 1 FROM test_sessions x WHERE x.test_code_subject_collection = 'physical_samples' AND x.test_code_subject_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM sample_genealogy x WHERE p.sample_id IN (x.parent_sample_id, x.child_sample_id))
   AND NOT EXISTS (SELECT 1 FROM campaign_samples x WHERE x.sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM sample_data_files x WHERE x.sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM sample_access x WHERE x.sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM sample_co_owners x WHERE x.sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM sample_team_access x WHERE x.sample_id = p.sample_id)
   AND NOT EXISTS (SELECT 1 FROM sample_stock_provenance x WHERE x.sample_id = p.sample_id);

INSERT INTO equipment (equipment_code, equipment_name, equipment_type, location, notes, project_id, is_active)
SELECT CASE WHEN EXISTS (SELECT 1 FROM equipment e WHERE e.equipment_code = s.slug)
            THEN s.slug || '-' || r.sample_code ELSE s.slug END,
       r.item_name, 'Rig_Kit', r.location,
       btrim(COALESCE(r.notes, '') || E'\n\nWas sample ' || r.sample_code || '.'),
       r.project_id, true
  FROM _rig_kit r
  CROSS JOIN LATERAL (SELECT btrim(regexp_replace(r.item_name, '[^A-Za-z0-9]+', '-', 'g'), '-') AS slug) s;

DELETE FROM physical_samples WHERE sample_id IN (SELECT sample_id FROM _rig_kit);

-- migrate:down
-- Not reversible by script: the moved rows are now equipment and may have been edited or referenced since. The original
-- physical_samples rows are in the audit log (audit_physical_samples), and each equipment row's notes end "Was sample <code>.".
SELECT 1;
