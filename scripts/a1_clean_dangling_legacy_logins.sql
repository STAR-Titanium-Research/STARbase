-- Operator step before migration 20261012000166 (record readers, A1a): remove the legacy co-owner and investigator rows whose
-- login no longer exists. sample_co_owners.user_id and project_investigators.user_id have no foreign key today, so deleting a login
-- left dangling rows; migration 166 adds ON DELETE CASCADE foreign keys to directus_users and REFUSES to run while any dangling row
-- exists (and says so). A dangling row grants nothing (no user can sign in as a deleted login) and cannot be shown in any list, so
-- removing it changes nothing anyone can see; the person_id column, where set, still names the People row.
--
-- Dry run by default: it lists the rows and rolls back. To remove them:
--     psql "$DATABASE_URL" -v apply=1 -f scripts/a1_clean_dangling_legacy_logins.sql
-- On live this is a maintainer step in docs/runbooks/a1-record-access-cutover.md ("dangling legacy logins"): run it dry, read the
-- listing, run it again with apply=1. The smoke and performance harnesses (scripts/dev/directus_smoke.sh) run it with apply=1 on
-- their throwaway copy of live before the migrations, in the "before" and the "after" runs alike.
\set ON_ERROR_STOP on
BEGIN;

\echo 'dangling sample_co_owners rows (user_id is not a directus_users row):'
SELECT c.id, c.sample_id, c.user_id, c.person_id FROM sample_co_owners c
 WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id);
\echo 'dangling project_investigators rows (user_id is not a directus_users row):'
SELECT i.id, i.project_id, i.user_id, i.person_id FROM project_investigators i
 WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = i.user_id);

DELETE FROM sample_co_owners c WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = c.user_id);
DELETE FROM project_investigators i WHERE NOT EXISTS (SELECT 1 FROM directus_users u WHERE u.id = i.user_id);

\if :{?apply}
\echo 'applied: the dangling rows are deleted (COMMIT)'
COMMIT;
\else
\echo 'dry run: nothing was changed (ROLLBACK). Run again with -v apply=1 to delete the rows above.'
ROLLBACK;
\endif
