-- migrate:up
-- One people row per human. Links researchers' people rows to their logins,
-- merges duplicate humans, standardises Dennis on dennis.premoli2, and records
-- the retired logins in login_aliases so later backfills map them to the
-- canonical login. All data fixes are guarded by EXISTS so a fresh database
-- (reset-db) without these rows is a no-op.

CREATE TABLE login_aliases (
    alias_user_id     uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
    canonical_user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE
);
COMMENT ON TABLE login_aliases IS
    'Retired duplicate logins -> the login that now represents that person. Used by ownership backfills.';

CREATE OR REPLACE FUNCTION merge_person(p_keep uuid, p_drop uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    r        record;
    v_email  text;
    v_user   uuid;
BEGIN
    IF p_keep IS NULL OR p_drop IS NULL OR p_keep = p_drop THEN
        RETURN;
    END IF;
    -- Junction rows that would duplicate an existing keep row are removed first.
    DELETE FROM sample_co_owners d USING sample_co_owners k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.sample_id = d.sample_id;
    DELETE FROM project_investigators d USING project_investigators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.project_id = d.project_id;
    FOR r IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'people'::regclass
    LOOP
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col) USING p_keep, p_drop;
    END LOOP;
    -- Carry over the email/login the keep row lacks (free the unique columns first).
    SELECT email, user_id INTO v_email, v_user FROM people WHERE person_id = p_drop;
    UPDATE people SET user_id = NULL, legacy_machine_operator_id = NULL WHERE person_id = p_drop;
    UPDATE people SET email = COALESCE(email, v_email), user_id = COALESCE(user_id, v_user)
     WHERE person_id = p_keep;
    DELETE FROM people WHERE person_id = p_drop;
END;
$$;
COMMENT ON FUNCTION merge_person(uuid, uuid) IS
    'Merge duplicate person p_drop into p_keep: repoint every FK to people, dedupe junction rows, delete p_drop.';

DO $$
DECLARE
    c_dennis_user   constant uuid := '59422866-e6be-463b-ac1f-a2c885034c2a';
    c_dennis_person constant uuid := '4319d317-d5eb-4c99-bf68-4d124e939525';
    c_dennis_junk   constant uuid := '7fb24303-dff3-4ccd-ba4e-68b6dc323b92';
    c_alias1        constant uuid := '39be2287-8c25-5f80-8c68-803cdaca77a1';
    c_alias2        constant uuid := '5e9b44c7-0938-4c94-9322-382bd48a3fdf';
    t               text;
    v_missing       text;
BEGIN
    -- Dennis -> dennis.premoli2
    IF EXISTS (SELECT 1 FROM directus_users WHERE id = c_dennis_user)
       AND EXISTS (SELECT 1 FROM people WHERE person_id = c_dennis_person) THEN
        INSERT INTO login_aliases (alias_user_id, canonical_user_id)
        SELECT u.id, c_dennis_user FROM directus_users u WHERE u.id IN (c_alias1, c_alias2)
        ON CONFLICT DO NOTHING;
        PERFORM merge_person(c_dennis_person, c_dennis_junk)
          WHERE EXISTS (SELECT 1 FROM people WHERE person_id = c_dennis_junk);
        UPDATE people SET user_id = NULL WHERE user_id IN (SELECT alias_user_id FROM login_aliases);
        UPDATE people SET user_id = c_dennis_user, email = 'dennis.premoli2@sheffield.ac.uk'
         WHERE person_id = c_dennis_person;
        UPDATE directus_users SET status = 'suspended' WHERE id IN (SELECT alias_user_id FROM login_aliases);
    END IF;

    -- James Pepper, Jack Krohn: login and person exist but were never linked.
    UPDATE people p SET user_id = u.id, email = COALESCE(p.email, u.email)
      FROM directus_users u
     WHERE (p.person_id, u.id) IN (
            ('fa2c6071-b0cc-4b7b-ac59-d5cad192b2ed'::uuid, '4b3ff4d5-76a3-4ca0-814c-b00338f2646a'::uuid),
            ('c01c8655-4eac-4c92-818b-6f3d4cab8fd7'::uuid, '13799975-b3fa-40b6-a8ab-975bc5f26e88'::uuid))
       AND p.user_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM people x WHERE x.user_id = u.id);

    -- Sam Lister: login-linked "Sam" + login-less "Sam Lister" are one human.
    IF EXISTS (SELECT 1 FROM people WHERE person_id = '07c65862-5937-45bd-91c5-b3fa722eb94b')
       AND EXISTS (SELECT 1 FROM people WHERE person_id = '8ad99d68-fb46-469b-901b-3db4b64a388d') THEN
        PERFORM merge_person('07c65862-5937-45bd-91c5-b3fa722eb94b', '8ad99d68-fb46-469b-901b-3db4b64a388d');
        UPDATE people SET full_name = 'Sam Lister' WHERE person_id = '07c65862-5937-45bd-91c5-b3fa722eb94b';
    END IF;

    -- Anyone who can log in is a researcher (can own records).
    UPDATE people SET is_researcher = true WHERE user_id IS NOT NULL AND NOT is_researcher;

    -- Repoint legacy login-based references from alias logins to the canonical login.
    FOREACH t IN ARRAY ARRAY['tool_boxes','cutting_inserts','insert_edges','physical_samples',
                             'manufacturing_operations','test_sessions','campaigns','etchants','prep_recipes'] LOOP
        EXECUTE format('UPDATE %I x SET owner = a.canonical_user_id FROM login_aliases a WHERE x.owner = a.alias_user_id', t);
    END LOOP;
    UPDATE projects x SET principal_investigator = a.canonical_user_id
      FROM login_aliases a WHERE x.principal_investigator = a.alias_user_id;
    DELETE FROM project_investigators d USING project_investigators k, login_aliases a
     WHERE d.user_id = a.alias_user_id AND k.user_id = a.canonical_user_id AND k.project_id = d.project_id;
    UPDATE project_investigators x SET user_id = a.canonical_user_id
      FROM login_aliases a WHERE x.user_id = a.alias_user_id;
    DELETE FROM sample_co_owners d USING sample_co_owners k, login_aliases a
     WHERE d.user_id = a.alias_user_id AND k.user_id = a.canonical_user_id AND k.sample_id = d.sample_id;
    UPDATE sample_co_owners x SET user_id = a.canonical_user_id
      FROM login_aliases a WHERE x.user_id = a.alias_user_id;

    -- Invariant: every usable login has a person.
    SELECT string_agg(u.email, ', ') INTO v_missing
      FROM directus_users u
     WHERE u.status <> 'suspended' AND NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id = u.id);
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'identity cleanup: logins without a person: %', v_missing;
    END IF;
END $$;

-- migrate:down
-- The person links/merges and suspensions above are data fixes and are not
-- reverted; only the helper objects are removed.
DROP FUNCTION IF EXISTS merge_person(uuid, uuid);
DROP TABLE IF EXISTS login_aliases;
