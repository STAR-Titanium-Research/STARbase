-- migrate:up
-- Generated from db/mappings/operator-mapping.xlsx by scripts/operator_mapping_to_sql.py.
-- Links legacy Machine_Operators entries to people: MAP -> existing person,
-- NEW -> create one person per distinct name; that person becomes the main
-- operator and any "additional people" go in the additional-operators
-- junctions. IGNORE rows keep only the operator_name text already on each run.
CREATE TEMP TABLE _opmap (
    machine_operator_id integer PRIMARY KEY,
    action text NOT NULL,
    person_name text,
    new_name text,
    researcher boolean NOT NULL,
    additional text[] NOT NULL
) ON COMMIT DROP;

INSERT INTO _opmap (machine_operator_id, action, person_name, new_name, researcher, additional) VALUES
    (121, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (144, 'MAP', 'Simon Graham', NULL, false, '{}'::text[]),
    (117, 'MAP', 'James Pepper', NULL, false, '{}'::text[]),
    (141, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (167, 'MAP', 'Cameron Barrie', NULL, false, '{}'::text[]),
    (93, 'MAP', 'Innes', NULL, false, '{}'::text[]),
    (119, 'MAP', 'Joe Hopkinson', NULL, false, '{}'::text[]),
    (101, 'MAP', 'Natasha', NULL, false, '{}'::text[]),
    (105, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (296, 'MAP', 'Sully Khan', NULL, false, '{}'::text[]),
    (111, 'MAP', 'Will', NULL, false, '{}'::text[]),
    (212, 'MAP', 'Jack Krohn', NULL, false, '{}'::text[]),
    (265, 'MAP', 'Oliver Levano Blanch', NULL, false, '{}'::text[]),
    (118, 'MAP', 'James Pepper', NULL, false, '{}'::text[]),
    (87, 'MAP', 'Billy', NULL, false, '{}'::text[]),
    (112, 'MAP', 'Xingjian', NULL, false, '{}'::text[]),
    (204, 'MAP', 'Henry Boyle', NULL, false, '{}'::text[]),
    (220, 'MAP', 'Jozef McGowan', NULL, false, '{}'::text[]),
    (100, 'MAP', 'Matthew Gelmetti', NULL, false, '{}'::text[]),
    (258, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (107, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (256, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (228, 'NEW', NULL, 'Kyle Marshall', false, '{}'::text[]),
    (243, 'MAP', 'Matthew Gelmetti', NULL, false, '{}'::text[]),
    (255, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (168, 'MAP', 'Cameron Barrie', NULL, false, '{}'::text[]),
    (175, 'NEW', NULL, 'Connor McCarthy', true, '{}'::text[]),
    (142, 'MAP', 'Sam Lister', NULL, false, ARRAY['Nigel Adams']::text[]),
    (183, 'MAP', 'Dennis Premoli', NULL, false, '{}'::text[]),
    (92, 'MAP', 'Idris', NULL, false, '{}'::text[]),
    (139, 'MAP', 'Sam Jackson', NULL, false, '{}'::text[]),
    (290, 'MAP', 'Simon Graham', NULL, false, '{}'::text[]),
    (264, 'MAP', 'Oliver Levano Blanch', NULL, false, '{}'::text[]),
    (286, 'MAP', 'Seb A', NULL, false, '{}'::text[]),
    (205, 'MAP', 'Henry Boyle', NULL, false, '{}'::text[]),
    (219, 'MAP', 'Joshua Taylor', NULL, false, '{}'::text[]),
    (124, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (102, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (162, 'NEW', NULL, 'Ben Thomas', false, '{}'::text[]),
    (166, 'MAP', 'Cameron Barrie', NULL, false, '{}'::text[]),
    (211, 'MAP', 'Jack Batty', NULL, false, '{}'::text[]),
    (223, 'NEW', NULL, 'Kyle Marshall', false, '{}'::text[]),
    (125, 'MAP', 'Nick Weston', NULL, false, '{}'::text[]),
    (129, 'MAP', 'Oliver Levano Blanch', NULL, false, ARRAY['Beatrice Fernandez']::text[]),
    (132, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (133, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (134, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (135, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (136, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (143, 'MAP', 'Sam Lister', NULL, false, ARRAY['Nigel Adams']::text[]),
    (138, 'MAP', 'Sam Lister', NULL, false, '{}'::text[]),
    (113, 'MAP', 'Xinzef', NULL, false, '{}'::text[]);
DELETE FROM _opmap WHERE machine_operator_id IS NULL;

INSERT INTO people (full_name, is_operator, is_researcher)
SELECT DISTINCT ON (lower(new_name)) new_name, true, researcher
  FROM _opmap m
 WHERE action = 'NEW'
   AND NOT EXISTS (SELECT 1 FROM people p WHERE lower(p.full_name) = lower(m.new_name))
 ORDER BY lower(new_name), researcher DESC;

DO $$
DECLARE v text;
BEGIN
    SELECT string_agg(DISTINCT n, ', ') INTO v
      FROM (SELECT COALESCE(person_name, new_name) AS n FROM _opmap WHERE action IN ('MAP', 'NEW')
            UNION ALL
            SELECT unnest(additional) FROM _opmap WHERE action IN ('MAP', 'NEW')) names
     WHERE (SELECT count(*) FROM people p WHERE lower(p.full_name) = lower(names.n)) <> 1;
    IF v IS NOT NULL THEN
        RAISE EXCEPTION 'operator mapping: names missing or ambiguous in people: %', v;
    END IF;
END $$;

UPDATE manufacturing_operations o SET operator_person_id = p.person_id
  FROM _opmap m JOIN people p ON lower(p.full_name) = lower(COALESCE(m.person_name, m.new_name))
 WHERE m.action IN ('MAP', 'NEW') AND o.operator = m.machine_operator_id AND o.operator_person_id IS NULL;

UPDATE test_sessions s SET operator_person_id = p.person_id
  FROM _opmap m JOIN people p ON lower(p.full_name) = lower(COALESCE(m.person_name, m.new_name))
 WHERE m.action IN ('MAP', 'NEW') AND s.operator = m.machine_operator_id AND s.operator_person_id IS NULL;

INSERT INTO operation_additional_operators (operation_id, person_id)
SELECT o.operation_id, p.person_id
  FROM _opmap m
  CROSS JOIN LATERAL unnest(m.additional) AS a(name)
  JOIN people p ON lower(p.full_name) = lower(a.name)
  JOIN manufacturing_operations o ON o.operator = m.machine_operator_id
 WHERE m.action IN ('MAP', 'NEW') AND p.person_id IS DISTINCT FROM o.operator_person_id
ON CONFLICT (operation_id, person_id) DO NOTHING;

INSERT INTO session_additional_operators (session_id, person_id)
SELECT s.session_id, p.person_id
  FROM _opmap m
  CROSS JOIN LATERAL unnest(m.additional) AS a(name)
  JOIN people p ON lower(p.full_name) = lower(a.name)
  JOIN test_sessions s ON s.operator = m.machine_operator_id
 WHERE m.action IN ('MAP', 'NEW') AND p.person_id IS DISTINCT FROM s.operator_person_id
ON CONFLICT (session_id, person_id) DO NOTHING;

-- migrate:down
-- Data backfill; not reverted.
SELECT 1;
