-- migrate:up
-- Copy every legacy login-based owner / PI / junction user into the
-- person-based field (via people.user_id), then assert nothing is left
-- unresolved. Person fields already set are authoritative and untouched.
DO $$
DECLARE
    t   text;
    n   bigint;
BEGIN
    FOREACH t IN ARRAY ARRAY['tool_boxes','cutting_inserts','insert_edges','physical_samples',
                             'manufacturing_operations','test_sessions','campaigns','etchants','prep_recipes'] LOOP
        EXECUTE format($f$
            UPDATE %I x SET owner_person_id = p.person_id
              FROM people p
             WHERE x.owner_person_id IS NULL AND x.owner IS NOT NULL
               AND p.user_id = COALESCE((SELECT a.canonical_user_id FROM login_aliases a WHERE a.alias_user_id = x.owner), x.owner)
        $f$, t);
        EXECUTE format('SELECT count(*) FROM %I WHERE owner IS NOT NULL AND owner_person_id IS NULL', t) INTO n;
        IF n > 0 THEN
            RAISE EXCEPTION 'backfill: % rows in % have an owner login with no person', n, t;
        END IF;
    END LOOP;

    UPDATE projects x SET principal_investigator_person = p.person_id
      FROM people p
     WHERE x.principal_investigator_person IS NULL AND x.principal_investigator IS NOT NULL
       AND p.user_id = x.principal_investigator;
    SELECT count(*) INTO n FROM projects WHERE principal_investigator IS NOT NULL AND principal_investigator_person IS NULL;
    IF n > 0 THEN RAISE EXCEPTION 'backfill: % projects have a PI login with no person', n; END IF;

    UPDATE project_investigators j SET person_id = p.person_id
      FROM people p WHERE j.person_id IS NULL AND p.user_id = j.user_id;
    UPDATE sample_co_owners j SET person_id = p.person_id
      FROM people p WHERE j.person_id IS NULL AND p.user_id = j.user_id;
    SELECT (SELECT count(*) FROM project_investigators WHERE person_id IS NULL)
         + (SELECT count(*) FROM sample_co_owners WHERE person_id IS NULL) INTO n;
    IF n > 0 THEN RAISE EXCEPTION 'backfill: % junction rows have a login with no person', n; END IF;
END $$;

-- migrate:down
-- Data backfill into already-existing person columns; nothing to revert.
SELECT 1;
