-- Demo showcase sample for the Sample Overview report (timeline + campaign/project
-- colour-coding). Idempotent: re-running replaces the DEMO-* records.
--
--   DEMO-TI64-BILLET  ──CUT_FROM──▶  DEMO-TI64-001  ──SECTIONED──▶  DEMO-TI64-C1
--                                          │                        DEMO-TI64-C2
--   life: created → 4 roughing ops (Campaign A / Project A, Apr)
--                 → 4 finishing ops (Campaign B / Project B, May)
--                 → 2 tensile tests (Campaign A, Jun)
--                 → 2 children sectioned (Jul)
BEGIN;

DELETE FROM test_sessions WHERE sample_id IN (SELECT sample_id FROM physical_samples WHERE sample_code LIKE 'DEMO-%');
DELETE FROM manufacturing_operations WHERE sample_id IN (SELECT sample_id FROM physical_samples WHERE sample_code LIKE 'DEMO-%');
DELETE FROM sample_genealogy WHERE child_sample_id IN (SELECT sample_id FROM physical_samples WHERE sample_code LIKE 'DEMO-%')
   OR parent_sample_id IN (SELECT sample_id FROM physical_samples WHERE sample_code LIKE 'DEMO-%');
DELETE FROM physical_samples WHERE sample_code LIKE 'DEMO-%';
DELETE FROM campaigns WHERE campaign_code LIKE 'DEMO-%';
DELETE FROM projects WHERE project_code LIKE 'DEMO-%';

INSERT INTO projects (project_code, project_name, description, principal_investigator_name, start_date) VALUES
 ('DEMO-PA','Ti-64 FAST Billet Study','Demonstration project A','Dr A. Researcher','2024-03-01'),
 ('DEMO-PB','Ti-64 Machinability','Demonstration project B','Dr B. Scientist','2024-04-15');

INSERT INTO campaigns (project_id, campaign_type, name, campaign_code, start_date, end_date)
SELECT project_id,'machining_trial','Roughing Campaign','DEMO-CA','2024-04-01'::date,'2024-04-30'::date FROM projects WHERE project_code='DEMO-PA'
UNION ALL
SELECT project_id,'machining_trial','Finishing Campaign','DEMO-CB','2024-05-01'::date,'2024-05-31'::date FROM projects WHERE project_code='DEMO-PB';

INSERT INTO physical_samples
 (sample_code, material_id, project_id, owner, nickname, location, surface_finish, form,
  mass_grams, diameter_mm, length_mm, manufactured_date, current_status, manufacturing_route, notes, created_at)
VALUES
 ('DEMO-TI64-BILLET','f6787f01-e840-5e81-86cf-279d968248ea',(SELECT project_id FROM projects WHERE project_code='DEMO-PA'),
  '39be2287-8c25-5f80-8c68-803cdaca77a1','FAST billet','D1 Store, Sheffield','As-sintered','billet',
  1200,40,120,'2024-02-10','active','FAST/SPS','Parent billet — FAST/SPS sintered Ti-64 powder (500 g).','2024-02-10'),
 ('DEMO-TI64-001','f6787f01-e840-5e81-86cf-279d968248ea',(SELECT project_id FROM projects WHERE project_code='DEMO-PA'),
  '39be2287-8c25-5f80-8c68-803cdaca77a1','Machinability disc','D1 Lab, Sir Robert Hadfield Building, Sheffield','Machined','disc',
  480,80,15,'2024-03-15','active','FAST/SPS → turned','Primary demonstration sample: cut from the FAST billet, turned across a roughing and a finishing campaign, tensile-tested, then sectioned into two child coupons.','2024-03-15'),
 ('DEMO-TI64-C1','f6787f01-e840-5e81-86cf-279d968248ea',(SELECT project_id FROM projects WHERE project_code='DEMO-PB'),
  '39be2287-8c25-5f80-8c68-803cdaca77a1','Tensile coupon','D1 Lab, Sheffield','Ground','coupon',95,10,60,'2024-07-05','active',NULL,'Child coupon sectioned for tensile testing.','2024-07-05'),
 ('DEMO-TI64-C2','f6787f01-e840-5e81-86cf-279d968248ea',(SELECT project_id FROM projects WHERE project_code='DEMO-PB'),
  '39be2287-8c25-5f80-8c68-803cdaca77a1','SEM coupon','D1 Lab, Sheffield','Polished','coupon',40,10,10,'2024-07-12','active',NULL,'Child coupon sectioned for electron microscopy.','2024-07-12');

INSERT INTO sample_genealogy (parent_sample_id, child_sample_id, relationship_type, fraction, created_at)
SELECT p.sample_id,c.sample_id,'cut_from',0.40,'2024-03-15'::timestamptz FROM physical_samples p, physical_samples c
   WHERE p.sample_code='DEMO-TI64-BILLET' AND c.sample_code='DEMO-TI64-001'
UNION ALL SELECT p.sample_id,c.sample_id,'cut_from',0.50,'2024-07-05'::timestamptz FROM physical_samples p, physical_samples c
   WHERE p.sample_code='DEMO-TI64-001' AND c.sample_code='DEMO-TI64-C1'
UNION ALL SELECT p.sample_id,c.sample_id,'cut_from',0.20,'2024-07-12'::timestamptz FROM physical_samples p, physical_samples c
   WHERE p.sample_code='DEMO-TI64-001' AND c.sample_code='DEMO-TI64-C2';

-- Roughing ops: Campaign A / Project A (April)
INSERT INTO manufacturing_operations
 (sample_id, method_id, project_id, campaign_id, pass_code, operation_date, operation_sequence,
  process_category, machining_operation_subtype, machining_cutting_speed_m_per_min, machining_feed_mm_per_rev,
  machining_spindle_speed_rpm, machining_axial_depth_of_cut_mm)
SELECT s.sample_id,'a7181c9c-2381-535a-9cb7-6fc3834990f1', pa.project_id, ca.campaign_id,
       'DEMO-TI64-001-R'||v.g, ('2024-04-0'||v.g)::date, v.g,'machining','MT-R', v.vc, 0.15, 1000, 0.5
FROM physical_samples s, projects pa, campaigns ca, (VALUES (1,20),(2,30),(3,40),(4,60)) AS v(g,vc)
WHERE s.sample_code='DEMO-TI64-001' AND pa.project_code='DEMO-PA' AND ca.campaign_code='DEMO-CA';

-- Finishing ops: Campaign B / Project B (May)
INSERT INTO manufacturing_operations
 (sample_id, method_id, project_id, campaign_id, pass_code, operation_date, operation_sequence,
  process_category, machining_operation_subtype, machining_cutting_speed_m_per_min, machining_feed_mm_per_rev,
  machining_spindle_speed_rpm, machining_axial_depth_of_cut_mm)
SELECT s.sample_id,'a7181c9c-2381-535a-9cb7-6fc3834990f1', pb.project_id, cb.campaign_id,
       'DEMO-TI64-001-F'||v.g, ('2024-05-0'||v.g)::date, 4+v.g,'machining','MT-F', v.vc, 0.05, 1500, 0.1
FROM physical_samples s, projects pb, campaigns cb, (VALUES (1,60),(2,80),(3,100),(4,120)) AS v(g,vc)
WHERE s.sample_code='DEMO-TI64-001' AND pb.project_code='DEMO-PB' AND cb.campaign_code='DEMO-CB';

-- Tensile tests: Campaign A / Project A (June)
INSERT INTO test_sessions
 (sample_id, project_id, campaign_id, session_date, test_type, operator_name, status,
  tensile_test_temp_celsius, tensile_crosshead_speed_mm_per_min, tensile_yield_strength_mpa, tensile_uts_mpa, tensile_elongation_pct)
SELECT s.sample_id, pa.project_id, ca.campaign_id, t.d,'tensile','A. Operator','analysed', 20, 0.5, t.ys, t.uts, t.el
FROM physical_samples s, projects pa, campaigns ca, (VALUES ('2024-06-05'::date,910,985,12.5),('2024-06-18'::date,928,1002,11.8)) AS t(d,ys,uts,el)
WHERE s.sample_code='DEMO-TI64-001' AND pa.project_code='DEMO-PA' AND ca.campaign_code='DEMO-CA';

-- The subject of a test lives in the junction (migration 063); sample_id is derived from it by a
-- trigger (migration 139), so write the junction rows too or a later subject edit would blank sample_id.
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
SELECT t.session_id, 'physical_samples', t.sample_id::text
FROM test_sessions t JOIN physical_samples s ON s.sample_id = t.sample_id
WHERE s.sample_code LIKE 'DEMO-%'
  AND NOT EXISTS (SELECT 1 FROM test_sessions_subject j WHERE j.test_sessions_id = t.session_id
                  AND j.collection = 'physical_samples' AND lower(j.item) = t.sample_id::text);

COMMIT;
