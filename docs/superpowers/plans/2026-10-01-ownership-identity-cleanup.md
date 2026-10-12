# Ownership & Identity Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `people` row per human, linked 1:1 to researchers' logins; owner prefills from the login, `created_by` is stamped automatically, and the duplicated login-based owner/operator/PI fields are removed.

**Architecture:** Postgres migrations (dbmate) do the data cleanup, backfills, new `created_by` columns and the final column drops. Three Directus hook extensions enforce behaviour server-side (auto-link people to new logins, default owner from the login, no owner inheritance). One Directus interface extension (`d1-owner-picker`) prefills the owner visibly in forms and offers a "same as parent" tick. Tests run against the live local stack through the Directus REST API with `node --test`.

**Tech Stack:** PostgreSQL 16 (pgvector image), dbmate 2 via Docker, Directus 11 (hooks: plain ESM `index.js`; interfaces: `@directus/extensions-sdk` ^17 + Vue 3), Node 24 built-in test runner, Python 3.13 (`py -3`, openpyxl, pytest) for the mapping converter.

**Spec:** `docs/superpowers/specs/2026-10-01-ownership-identity-cleanup-design.md`

## Global Constraints

- Canonical Dennis login: `dennis.premoli2@sheffield.ac.uk` = user `59422866-e6be-463b-ac1f-a2c885034c2a`, person `4319d317-d5eb-4c99-bf68-4d124e939525`. Alias logins to suspend: `39be2287-8c25-5f80-8c68-803cdaca77a1` (dpremoli1), `5e9b44c7-0938-4c94-9322-382bd48a3fdf` (dennis.premoli@gmail.com).
- Roles: Lab Admin `10000001-0000-0000-0000-000000000001`, Lab Member `10000001-0000-0000-0000-000000000002`.
- Owners are researchers only (`people.is_researcher = true` and `people.user_id IS NOT NULL`). Operators may be any person.
- Default owner on create = logged-in user's person ("login wins"). Parent inheritance only via the "same as parent" tick. Bulk box intake: the intake form's owner applies to every generated box, insert and edge.
- Ownable collections → owner field: `physical_samples, tool_boxes, cutting_inserts, insert_edges, etchants, prep_recipes, campaigns, manufacturing_operations, test_sessions` → `owner_person_id`; `projects` → `principal_investigator_person`.
- The force app must keep working with **no change under `apps/force-app`**. The only shared-code change is one extra condition in `packages/force-plotting/src/ForceDashboard.vue` (Task 10) so additional operators see their runs.
- Several operators per run: `operator_person_id` stays the **main** operator; extra operators live in `operation_additional_operators` / `session_additional_operators` (Directus field "Additional operators" on both forms).
- Migrations: one file per migration in `db/migrations/`, named `20261001000NNN_<name>.sql`, with `-- migrate:up` / `-- migrate:down`. Apply with:
  ```bash
  DBURL=$(grep ^DATABASE_URL= .env | cut -d= -f2- | sed 's/@localhost:/@postgres:/')
  docker run --rm -e DATABASE_URL="$DBURL" --network d1-database_d1net -v "//d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database/db:/db" ghcr.io/amacneil/dbmate:2 --no-dump-schema up
  ```
  (Roll back the latest: same command with `down` instead of `up`.)
- After any change to `directus_fields`, `directus_relations`, `directus_permissions` or any extension, reload Directus:
  ```bash
  docker exec d1-database-redis-1 redis-cli FLUSHALL && docker restart d1-database-directus-1 && until [ "$(docker inspect --format='{{.State.Health.Status}}' d1-database-directus-1)" = healthy ]; do sleep 3; done
  ```
- **Never re-run `scripts/configure_directus.sql` wholesale** (its blanket DELETE wipes later migrations' metadata). Metadata changes go in migrations and are *mirrored* by editing that file's rows.
- Run SQL ad hoc with `docker exec d1-database-postgres-1 psql -U d1 -d d1_database -c "<sql>"` (no host psql).
- Do not stage `docs/force-app-operations.md` (someone else's unrelated edit).

## Review Focus

1. A login with **no linked researcher** (machine token, or a user whose person isn't a researcher) creates a record → the write succeeds and the owner stays blank. Test: Task 6, `machine-like login leaves owner blank`.
2. Editing an existing record whose owner is **not** a researcher (legacy technician owner) → the owner is preserved and still shown. Test: Task 6, `PATCH keeps a non-researcher owner`; Task 8 picker adds the current value's label to the list.
3. A new login whose email/name matches **more than one** unlinked person → a new person is created; neither existing row is linked. Test: Task 2, `ambiguous name creates a new person`.
4. Bulk box intake where the user picks **someone else** as owner → the whole batch gets the chosen owner, not the login. Test: Task 7, `intake with chosen owner carries it to every row`.
5. A force-app write that sends `owner_person_id: null` explicitly (offline queue payloads may) → treated as blank and filled from the login; operator preserved. Test: Task 6, `explicit null owner is filled from login`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `tests/ownership/lib.mjs` | Shared test helpers: env loading, REST calls, `sql()` via docker psql, temp researcher/user lifecycle |
| `tests/ownership/*.test.mjs` | One test file per task |
| `db/migrations/20261001000120_identity_cleanup.sql` | `login_aliases`, `merge_person()`, link/merge people, suspend alias logins, repoint legacy login FKs, invariant assertion |
| `db/migrations/20261001000121_backfill_person_fields.sql` | Owner/PI/junction `person_id` backfill + assertions |
| `db/migrations/20261001000122_additional_operators.sql` | Junctions `operation_additional_operators` / `session_additional_operators`, Directus M2M, Lab Member permissions, `merge_person` dedupe |
| `scripts/operator_mapping_to_sql.py` | Converts the curated `db/mappings/operator-mapping.xlsx` into migration 123 |
| `db/migrations/20261001000123_operator_backfill.sql` | Generated; creates NEW people, sets `operator_person_id`, fills additional operators |
| `packages/force-plotting/src/ForceDashboard.vue` | Dashboard scoping also matches additional operators |
| `db/migrations/20261001000124_created_by.sql` | `created_by` columns, audit backfill, Directus field + relation |
| `core/extensions/d1-person-link/` | Hook: link/create a `people` row when a login is created |
| `core/extensions/d1-owner-default/` | Hook: blank owner on create → logged-in researcher (replaces `d1-default-owner`) |
| `core/extensions/campaign-inherit/index.js` | Keep project/equipment/material defaults; remove owner inheritance |
| `db/migrations/20261001000125_intake_owner_explicit.sql` | Intake function sets owner explicitly; triggers stop filling owner |
| `core/extensions/d1-owner-picker/` | Interface: researcher-only dropdown, prefill, "same as parent" |
| `db/migrations/20261001000126_owner_picker_fields.sql` | Switch owner fields to `d1-owner-picker` |
| `db/migrations/20261001000127_drop_legacy_ownership.sql` | Drop legacy columns, junction swap, view rewrite, metadata cleanup |
| `scripts/fast_mapping.py`, `scripts/import_*.py`, `scripts/transfer_sample_ownership.py` | Write person fields instead of dropped columns |
| `scripts/configure_directus.sql`, `scripts/configure_campaigns.sql`, `scripts/configure_sample_prep.sql` | Mirror metadata changes |

---

### Task 0: Branch setup and commit the earlier DB fixes

**Files:** none created; commits existing working-tree files.

- [ ] **Step 1: Confirm you are on the ownership branch with the uncommitted work**

(The working tree was already switched here during planning; `main` and `feat/frm-color-scale` had identical copies of the carried files.)

```bash
git branch --show-current
git status --short
```
Expected: `feat/ownership-identity-cleanup`; modified `db/schema.sql`, `scripts/configure_directus.sql`, `docs/force-app-operations.md`, `docs/superpowers/specs/2026-10-01-ownership-identity-cleanup-design.md`; untracked migrations `20260930000114`–`119`, `db/mappings/operator-mapping.xlsx`, this plan.

- [ ] **Step 1b: Back up the live database before any data migration**

Tasks 1, 3, 4 and 9 merge people and drop columns on the lab's live database; their `migrate:down` sections cannot restore data. Take a backup first:
```bash
bash infra/backup/backup.sh
```
Expected: the script reports a `d1_<timestamp>.sql.gz` uploaded to MinIO. Note the filename in the task log (restore: `make restore BACKUP_FILE=d1_<timestamp>.sql.gz`). Do not start Task 1 if the backup failed.

- [ ] **Step 2: Commit the already-applied fixes (114–119) as their own commit**

```bash
git add db/migrations/20260930000114_intake_expansion_and_code_generation.sql db/migrations/20260930000115_projects_pi_image_field_meta.sql db/migrations/20260930000116_campaign_children_relation.sql db/migrations/20260930000117_plain_placeholder_defaults.sql db/migrations/20260930000118_edge_display_template_dedup.sql db/migrations/20260930000119_lab_member_missing_permissions.sql db/schema.sql scripts/configure_directus.sql
git commit -m "fix(db): box intake expansion, auto-generated codes, form fixes, Lab Member permissions"
```

- [ ] **Step 3: Commit the spec update, the plan and the curated operator mapping sheet**

```bash
git add docs/superpowers/specs/2026-10-01-ownership-identity-cleanup-design.md docs/superpowers/plans/2026-10-01-ownership-identity-cleanup.md db/mappings/operator-mapping.xlsx
git commit -m "docs(plan): ownership cleanup plan, additional operators, curated operator mapping"
```

---

### Task 1: Test harness + identity cleanup migration

**Files:**
- Create: `tests/ownership/lib.mjs`
- Create: `tests/ownership/identity.test.mjs`
- Create: `db/migrations/20261001000120_identity_cleanup.sql`

**Interfaces:**
- Produces (lib.mjs): `env`, `BASE`, `sql(query) -> string[][]`, `sqlOne(query) -> string|null`, `api(method, path, token, body) -> {status, data}`, `login(email, password) -> token`, `adminToken() -> token`, `LAB_MEMBER_ROLE`, `createUser(admin, label, {role}) -> {userId, email, password, token}`, `personOf(userId) -> string|null`, `deleteUser(admin, userId)`.
- Produces (SQL): table `login_aliases(alias_user_id uuid PK, canonical_user_id uuid)`; function `merge_person(p_keep uuid, p_drop uuid) returns void` (repoints every FK to `people`, dedupes junction rows, deletes `p_drop`).

- [ ] **Step 1: Write the test helpers**

`tests/ownership/lib.mjs`:
```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function loadEnv() {
	const e = { ...process.env };
	try {
		const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && !(m[1] in e)) e[m[1]] = m[2];
		}
	} catch { /* rely on process env */ }
	return e;
}

export const env = loadEnv();
export const BASE = env.DIRECTUS_TEST_URL || 'http://localhost:8055';
export const LAB_MEMBER_ROLE = '10000001-0000-0000-0000-000000000002';

export function sql(query) {
	const out = execFileSync('docker', ['exec', 'd1-database-postgres-1', 'psql', '-U', 'd1', '-d', 'd1_database',
		'-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', '-c', query], { encoding: 'utf8' }).trim();
	return out === '' ? [] : out.split('\n').map((l) => l.split('\t'));
}

export function sqlOne(query) {
	const rows = sql(query);
	return rows[0]?.[0] ?? null;
}

export async function api(method, path, token, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let data;
	try { data = JSON.parse(text); } catch { data = text; }
	return { status: res.status, data };
}

export async function login(email, password) {
	const r = await api('POST', '/auth/login', null, { email, password });
	if (r.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(r.data)}`);
	return r.data.data.access_token;
}

export function adminToken() {
	return login(env.DIRECTUS_ADMIN_EMAIL, env.DIRECTUS_ADMIN_PASSWORD);
}

export async function createUser(admin, label, { role = LAB_MEMBER_ROLE, first = 'OwnTest', last = label, email } = {}) {
	const password = `Tmp-${Math.random().toString(36).slice(2)}-Aa1!`;
	const addr = email || `own-test-${label.toLowerCase()}-${Date.now()}@example.com`;
	const r = await api('POST', '/users', admin, { email: addr, password, role, status: 'active', first_name: first, last_name: last });
	if (r.status !== 200) throw new Error(`createUser failed: ${JSON.stringify(r.data)}`);
	const userId = r.data.data.id;
	const token = await login(addr, password);
	return { userId, email: addr, password, token };
}

export function personOf(userId) {
	return sqlOne(`SELECT person_id FROM people WHERE user_id = '${userId}'`);
}

export async function deleteUser(admin, userId) {
	sql(`DELETE FROM people WHERE user_id = '${userId}'`);
	await api('DELETE', `/users/${userId}`, admin);
}
```

- [ ] **Step 2: Write the failing identity tests**

`tests/ownership/identity.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql, sqlOne } from './lib.mjs';

test('every non-suspended login has exactly one person', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM directus_users u
		WHERE u.status <> 'suspended' AND NOT EXISTS (SELECT 1 FROM people p WHERE p.user_id = u.id)`), '0');
});

test('every login-linked person is a researcher', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE user_id IS NOT NULL AND NOT is_researcher`), '0');
});

test('Dennis is standardised on dennis.premoli2 and the other logins are suspended', () => {
	assert.equal(sqlOne(`SELECT user_id FROM people WHERE person_id = '4319d317-d5eb-4c99-bf68-4d124e939525'`),
		'59422866-e6be-463b-ac1f-a2c885034c2a');
	assert.equal(sqlOne(`SELECT count(*) FROM directus_users WHERE status = 'suspended'
		AND id IN ('39be2287-8c25-5f80-8c68-803cdaca77a1','5e9b44c7-0938-4c94-9322-382bd48a3fdf')`), '2');
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE full_name = 'dennis.premoli@gmail.com'`), '0');
});

test('Sam Lister is one person linked to his login', () => {
	assert.deepEqual(sql(`SELECT u.email FROM people p JOIN directus_users u ON u.id = p.user_id WHERE p.full_name = 'Sam Lister'`),
		[['sam.lister@sheffield.ac.uk']]);
	assert.equal(sqlOne(`SELECT count(*) FROM people WHERE full_name IN ('Sam', 'Sam Lister')`), '1');
});

test('James Pepper and Jack Krohn are linked to their logins', () => {
	assert.equal(sqlOne(`SELECT u.email FROM people p JOIN directus_users u ON u.id = p.user_id WHERE p.full_name = 'James Pepper'`),
		'j.g.pepper@sheffield.ac.uk');
	assert.equal(sqlOne(`SELECT u.email FROM people p JOIN directus_users u ON u.id = p.user_id WHERE p.full_name = 'Jack Krohn'`),
		'jjkrohn1@sheffield.ac.uk');
});

test('no legacy login FK still points at an alias login', () => {
	assert.equal(sqlOne(`SELECT
		(SELECT count(*) FROM campaigns WHERE owner IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM physical_samples WHERE owner IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM manufacturing_operations WHERE owner IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM projects WHERE principal_investigator IN (SELECT alias_user_id FROM login_aliases))
		+ (SELECT count(*) FROM project_investigators WHERE user_id IN (SELECT alias_user_id FROM login_aliases))`), '0');
});

test('merge_person repoints references and removes the dropped row', () => {
	const [keep, drop] = sql(`INSERT INTO people (full_name) VALUES ('MergeTest Keep'), ('MergeTest Drop') RETURNING person_id`).map((r) => r[0]);
	const sample = sqlOne(`INSERT INTO physical_samples (sample_code, owner_person_id) VALUES ('MERGE-TEST-${Date.now()}', '${drop}') RETURNING sample_id`);
	try {
		sql(`SELECT merge_person('${keep}', '${drop}')`);
		assert.equal(sqlOne(`SELECT owner_person_id FROM physical_samples WHERE sample_id = '${sample}'`), keep);
		assert.equal(sqlOne(`SELECT count(*) FROM people WHERE person_id = '${drop}'`), '0');
	} finally {
		sql(`DELETE FROM physical_samples WHERE sample_id = '${sample}'`);
		sql(`DELETE FROM people WHERE person_id IN ('${keep}', '${drop}')`);
	}
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test tests/ownership/identity.test.mjs`
Expected: FAIL — e.g. `every non-suspended login has exactly one person` (3 logins have no person), `merge_person` (function does not exist).

- [ ] **Step 4: Write the migration**

`db/migrations/20261001000120_identity_cleanup.sql`:
```sql
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
```

- [ ] **Step 5: Apply the migration**

Run the dbmate `up` command from Global Constraints.
Expected: `Applied: 20261001000120_identity_cleanup.sql`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test tests/ownership/identity.test.mjs`
Expected: 7 passing.

- [ ] **Step 7: Commit**

```bash
git add tests/ownership/lib.mjs tests/ownership/identity.test.mjs db/migrations/20261001000120_identity_cleanup.sql
git commit -m "feat(db): one person per human — link logins, merge duplicates, standardise Dennis's login"
```

---

### Task 2: Auto-link a person to every new login

**Files:**
- Create: `core/extensions/d1-person-link/index.js`
- Create: `core/extensions/d1-person-link/package.json`
- Create: `tests/ownership/person-link.test.mjs`

**Interfaces:**
- Consumes: `createUser`, `personOf`, `deleteUser`, `sql`, `sqlOne`, `adminToken` from Task 1.
- Produces: after this task, every login created through Directus has a researcher `people` row — Tasks 5–8 tests rely on `personOf(userId)` returning a person for users made by `createUser`.

- [ ] **Step 1: Write the failing tests**

`tests/ownership/person-link.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

test('a new login with no matching person gets a new researcher person', async () => {
	const admin = await adminToken();
	const u = await createUser(admin, 'Fresh');
	try {
		const p = personOf(u.userId);
		assert.ok(p, 'person created');
		assert.equal(sqlOne(`SELECT is_researcher FROM people WHERE person_id = '${p}'`), 't');
		assert.equal(sqlOne(`SELECT full_name FROM people WHERE person_id = '${p}'`), 'OwnTest Fresh');
	} finally { await deleteUser(admin, u.userId); }
});

test('a new login links an existing unlinked person with the same email', async () => {
	const admin = await adminToken();
	const email = `own-test-link-${Date.now()}@example.com`;
	const existing = sqlOne(`INSERT INTO people (full_name, email, is_operator) VALUES ('Linky Tech', '${email}', true) RETURNING person_id`);
	const u = await createUser(admin, 'Linky', { email });
	try {
		assert.equal(personOf(u.userId), existing);
		assert.equal(sqlOne(`SELECT is_researcher FROM people WHERE person_id = '${existing}'`), 't');
	} finally {
		await deleteUser(admin, u.userId);
		sql(`DELETE FROM people WHERE person_id = '${existing}'`);
	}
});

test('ambiguous name creates a new person instead of linking either', async () => {
	const admin = await adminToken();
	const tag = `Twin${Date.now()}`;
	const twins = sql(`INSERT INTO people (full_name) VALUES ('OwnTest ${tag}'), ('OwnTest ${tag}') RETURNING person_id`).map((r) => r[0]);
	const u = await createUser(admin, tag);
	try {
		const p = personOf(u.userId);
		assert.ok(p);
		assert.ok(!twins.includes(p), 'did not link an ambiguous existing row');
	} finally {
		await deleteUser(admin, u.userId);
		sql(`DELETE FROM people WHERE person_id IN ('${twins.join("','")}')`);
	}
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/ownership/person-link.test.mjs`
Expected: FAIL — `person created` assertion (no hook yet, `personOf` returns null).

- [ ] **Step 3: Write the hook**

`core/extensions/d1-person-link/package.json`:
```json
{
  "name": "directus-extension-d1-person-link",
  "version": "1.0.0",
  "type": "module",
  "description": "Links (or creates) the people row for every new login, so one login = one person.",
  "keywords": ["directus", "directus-extension", "directus-custom-hook"],
  "directus:extension": {
    "type": "hook",
    "path": "index.js",
    "source": "index.js",
    "host": "^11.0.0"
  }
}
```

`core/extensions/d1-person-link/index.js`:
```js
// Directus hook: d1-person-link
//
// One login = one person. When a login is created, link the single unlinked
// people row with the same email (else the same full name); if there is no
// unique match, create a new person. Linked people are researchers (they can
// own records). Ambiguous matches never link, so two same-named technicians
// can't be silently attached to the wrong login.

async function uniqueUnlinked(db, column, value) {
	const rows = await db('people').whereNull('user_id').whereRaw(`lower(${column}) = ?`, [value]).limit(2).select('person_id');
	return rows.length === 1 ? rows[0].person_id : null;
}

export default ({ action }) => {
	action('users.create', async ({ key, payload }, { database }) => {
		if (!key || !database) return;
		if (await database('people').where('user_id', key).first('person_id')) return;
		const email = String(payload?.email ?? '').trim().toLowerCase();
		const name = `${payload?.first_name ?? ''} ${payload?.last_name ?? ''}`.trim();
		const match = (email && await uniqueUnlinked(database, 'email', email))
			|| (name && await uniqueUnlinked(database, 'full_name', name.toLowerCase()));
		if (match) {
			await database('people').where('person_id', match).update({
				user_id: key,
				is_researcher: true,
				email: database.raw('COALESCE(email, ?)', [email || null]),
			});
		} else {
			await database('people').insert({ full_name: name || email || 'Unnamed user', email: email || null, user_id: key, is_researcher: true });
		}
	});
};
```

- [ ] **Step 4: Reload Directus**

Run the reload command from Global Constraints. Then confirm it loaded: `docker logs d1-database-directus-1 --since 2m 2>&1 | grep -i "person-link\|error" || true` — expect no errors.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/ownership/person-link.test.mjs tests/ownership/identity.test.mjs`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add core/extensions/d1-person-link tests/ownership/person-link.test.mjs
git commit -m "feat(directus): link or create a person for every new login"
```

---

### Task 3: Backfill person-based owner, PI and junction fields

**Files:**
- Create: `db/migrations/20261001000121_backfill_person_fields.sql`
- Create: `tests/ownership/backfill.test.mjs`

**Interfaces:**
- Consumes: `login_aliases` (Task 1).
- Produces: every legacy `owner`/`principal_investigator`/junction `user_id` value has a matching person field; Task 9 relies on this before dropping columns.

- [ ] **Step 1: Write the failing test**

`tests/ownership/backfill.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlOne } from './lib.mjs';

const OWNED = ['tool_boxes', 'cutting_inserts', 'insert_edges', 'physical_samples', 'manufacturing_operations',
	'test_sessions', 'campaigns', 'etchants', 'prep_recipes'];

for (const t of OWNED) {
	test(`${t}: every legacy owner has an owner_person_id`, () => {
		assert.equal(sqlOne(`SELECT count(*) FROM ${t} WHERE owner IS NOT NULL AND owner_person_id IS NULL`), '0');
	});
}

test('projects: every legacy PI has a principal_investigator_person', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM projects WHERE principal_investigator IS NOT NULL AND principal_investigator_person IS NULL`), '0');
});

test('junctions: every row has a person_id', () => {
	assert.equal(sqlOne(`SELECT (SELECT count(*) FROM project_investigators WHERE person_id IS NULL) + (SELECT count(*) FROM sample_co_owners WHERE person_id IS NULL)`), '0');
});

test("James Pepper's historical operations now carry his person", () => {
	assert.ok(Number(sqlOne(`SELECT count(*) FROM manufacturing_operations WHERE owner_person_id = 'fa2c6071-b0cc-4b7b-ac59-d5cad192b2ed'`)) >= 202);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/ownership/backfill.test.mjs`
Expected: FAIL on `manufacturing_operations` (473 rows), `junctions` (3 rows), James Pepper.

- [ ] **Step 3: Write the migration**

`db/migrations/20261001000121_backfill_person_fields.sql`:
```sql
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
```

- [ ] **Step 4: Apply the migration**

Run the dbmate `up` command. Expected: `Applied: 20261001000121_backfill_person_fields.sql`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/ownership/backfill.test.mjs`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/20261001000121_backfill_person_fields.sql tests/ownership/backfill.test.mjs
git commit -m "feat(db): backfill person-based owner, PI and investigator fields from legacy logins"
```

---

### Task 3A: Additional operators (several people per run)

**Files:**
- Create: `db/migrations/20261001000122_additional_operators.sql`
- Create: `tests/ownership/additional-operators.test.mjs`

**Interfaces:**
- Consumes: `merge_person` (Task 1) — redefined here to also dedupe the new junctions.
- Produces: tables `operation_additional_operators(id uuid PK, operation_id → manufacturing_operations, person_id → people, UNIQUE(operation_id, person_id))` and `session_additional_operators(id, session_id → test_sessions, person_id → people, UNIQUE(session_id, person_id))`; Directus M2M alias field `additional_operators` on `manufacturing_operations` and `test_sessions` (junction field `person_id`). Task 4 inserts into these tables; Task 10's dashboard filter reads `operation_id.additional_operators.person_id`.

- [ ] **Step 1: Write the failing tests**

`tests/ownership/additional-operators.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

test('a researcher can record several operators on an operation', async () => {
	const admin = await adminToken();
	const u = await createUser(admin, 'MultiOp');
	const methodId = sqlOne(`SELECT method_id FROM manufacturing_methods WHERE method_code = 'MT'`);
	const [t1, t2] = sql(`INSERT INTO people (full_name, is_operator) VALUES ('OwnTest TechA ${Date.now()}', true), ('OwnTest TechB ${Date.now()}', true) RETURNING person_id`).map((r) => r[0]);
	let opId;
	try {
		const r = await api('POST', '/items/manufacturing_operations', u.token, {
			method_id: methodId, operator_person_id: t1, additional_operators: [{ person_id: t2 }],
		});
		assert.equal(r.status, 200, JSON.stringify(r.data));
		opId = r.data.data.operation_id;
		const g = await api('GET', `/items/manufacturing_operations/${opId}?fields=operator_person_id,additional_operators.person_id`, u.token);
		assert.equal(g.status, 200, JSON.stringify(g.data));
		assert.equal(g.data.data.operator_person_id, t1);
		assert.deepEqual(g.data.data.additional_operators.map((x) => x.person_id), [t2]);
	} finally {
		if (opId) await api('DELETE', `/items/manufacturing_operations/${opId}`, admin);
		sql(`DELETE FROM people WHERE person_id IN ('${t1}', '${t2}')`);
		await deleteUser(admin, u.userId);
	}
});

test('test sessions accept additional operators too', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM directus_relations WHERE many_collection = 'session_additional_operators' AND many_field = 'session_id' AND one_field = 'additional_operators'`), '1');
});

test('merge_person dedupes an additional-operator row that would clash', () => {
	const op = sqlOne(`SELECT operation_id FROM manufacturing_operations LIMIT 1`);
	const [keep, drop] = sql(`INSERT INTO people (full_name) VALUES ('OwnTest MKeep'), ('OwnTest MDrop') RETURNING person_id`).map((r) => r[0]);
	try {
		sql(`INSERT INTO operation_additional_operators (operation_id, person_id) VALUES ('${op}', '${keep}'), ('${op}', '${drop}')`);
		sql(`SELECT merge_person('${keep}', '${drop}')`);
		assert.equal(sqlOne(`SELECT count(*) FROM operation_additional_operators WHERE operation_id = '${op}' AND person_id = '${keep}'`), '1');
	} finally {
		sql(`DELETE FROM operation_additional_operators WHERE person_id IN ('${keep}', '${drop}')`);
		sql(`DELETE FROM people WHERE person_id IN ('${keep}', '${drop}')`);
	}
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/ownership/additional-operators.test.mjs`
Expected: FAIL — relation `operation_additional_operators` does not exist.

- [ ] **Step 3: Write the migration**

`db/migrations/20261001000122_additional_operators.sql`:
```sql
-- migrate:up
-- Several people can run one operation / test session. operator_person_id stays
-- the MAIN operator (the force app sets exactly one); everyone else who ran it
-- goes in these junctions, shown as "Additional operators" on the forms.

CREATE TABLE operation_additional_operators (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation_id uuid NOT NULL REFERENCES manufacturing_operations(operation_id) ON DELETE CASCADE,
    person_id    uuid NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    CONSTRAINT operation_additional_operators_unique UNIQUE (operation_id, person_id)
);
CREATE INDEX operation_additional_operators_person_idx ON operation_additional_operators (person_id);
COMMENT ON TABLE operation_additional_operators IS 'People who ran a manufacturing operation besides its main operator (operator_person_id).';

CREATE TABLE session_additional_operators (
    id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id uuid NOT NULL REFERENCES test_sessions(session_id) ON DELETE CASCADE,
    person_id  uuid NOT NULL REFERENCES people(person_id) ON DELETE CASCADE,
    CONSTRAINT session_additional_operators_unique UNIQUE (session_id, person_id)
);
CREATE INDEX session_additional_operators_person_idx ON session_additional_operators (person_id);
COMMENT ON TABLE session_additional_operators IS 'People who ran a test session besides its main operator (operator_person_id).';

-- Directus: hidden junction collections, M2M alias fields, relations (pattern of campaign_samples, 20260710000087).
INSERT INTO directus_collections (collection, icon, note, hidden, sort)
VALUES ('operation_additional_operators', 'group', 'M2M junction: operation <-> additional operator', true, 90),
       ('session_additional_operators',   'group', 'M2M junction: test session <-> additional operator', true, 91)
ON CONFLICT (collection) DO NOTHING;

INSERT INTO directus_fields (collection, field, interface, special, options, width, sort, hidden, translations)
SELECT v.collection, v.field, v.interface, v.special, v.options::json, v.width, v.sort, v.hidden, v.translations::json
FROM (VALUES
    ('operation_additional_operators', 'operation_id', 'select-dropdown-m2o', 'm2o', NULL, 'half', 1, false, NULL),
    ('operation_additional_operators', 'person_id',    'select-dropdown-m2o', 'm2o', '{"template":"{{full_name}}"}', 'half', 2, false, NULL),
    ('session_additional_operators',   'session_id',   'select-dropdown-m2o', 'm2o', NULL, 'half', 1, false, NULL),
    ('session_additional_operators',   'person_id',    'select-dropdown-m2o', 'm2o', '{"template":"{{full_name}}"}', 'half', 2, false, NULL),
    ('manufacturing_operations', 'additional_operators', 'list-m2m', 'm2m',
        '{"template":"{{person_id.full_name}}","junction_field":"person_id","enableCreate":false}', 'half', 9, false,
        '[{"language":"en-US","translation":"Additional operators"}]'),
    ('test_sessions', 'additional_operators', 'list-m2m', 'm2m',
        '{"template":"{{person_id.full_name}}","junction_field":"person_id","enableCreate":false}', 'half', 9, false,
        '[{"language":"en-US","translation":"Additional operators"}]')
) v(collection, field, interface, special, options, width, sort, hidden, translations)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

INSERT INTO directus_relations (many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action)
SELECT * FROM (VALUES
    ('operation_additional_operators', 'operation_id', 'manufacturing_operations', 'additional_operators', 'person_id',    'delete'),
    ('operation_additional_operators', 'person_id',    'people',                   NULL,                   'operation_id', 'nullify'),
    ('session_additional_operators',   'session_id',   'test_sessions',            'additional_operators', 'person_id',    'delete'),
    ('session_additional_operators',   'person_id',    'people',                   NULL,                   'session_id',   'nullify')
) v(many_collection, many_field, one_collection, one_field, junction_field, one_deselect_action)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.many_collection AND r.many_field = v.many_field);

-- Lab Members can record additional operators (same full-CRUD pattern as their other lab-data collections).
INSERT INTO directus_permissions (collection, action, fields, policy)
SELECT v.collection, v.action, '*', '20000002-0000-0000-0000-000000000002'
FROM (VALUES
    ('operation_additional_operators', 'create'), ('operation_additional_operators', 'read'),
    ('operation_additional_operators', 'update'), ('operation_additional_operators', 'delete'),
    ('session_additional_operators', 'create'), ('session_additional_operators', 'read'),
    ('session_additional_operators', 'update'), ('session_additional_operators', 'delete')
) v(collection, action)
WHERE NOT EXISTS (SELECT 1 FROM directus_permissions p WHERE p.policy = '20000002-0000-0000-0000-000000000002'
                  AND p.collection = v.collection AND p.action = v.action);

-- merge_person: also dedupe the new junctions before repointing.
CREATE OR REPLACE FUNCTION merge_person(p_keep uuid, p_drop uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    r       record;
    v_email text;
    v_user  uuid;
BEGIN
    IF p_keep IS NULL OR p_drop IS NULL OR p_keep = p_drop THEN
        RETURN;
    END IF;
    DELETE FROM sample_co_owners d USING sample_co_owners k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.sample_id = d.sample_id;
    DELETE FROM project_investigators d USING project_investigators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.project_id = d.project_id;
    DELETE FROM operation_additional_operators d USING operation_additional_operators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.operation_id = d.operation_id;
    DELETE FROM session_additional_operators d USING session_additional_operators k
     WHERE d.person_id = p_drop AND k.person_id = p_keep AND k.session_id = d.session_id;
    FOR r IN
        SELECT c.conrelid::regclass AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'people'::regclass
    LOOP
        EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col) USING p_keep, p_drop;
    END LOOP;
    SELECT email, user_id INTO v_email, v_user FROM people WHERE person_id = p_drop;
    UPDATE people SET user_id = NULL, legacy_machine_operator_id = NULL WHERE person_id = p_drop;
    UPDATE people SET email = COALESCE(email, v_email), user_id = COALESCE(user_id, v_user)
     WHERE person_id = p_keep;
    DELETE FROM people WHERE person_id = p_drop;
END;
$$;

-- migrate:down
DELETE FROM directus_permissions
 WHERE policy = '20000002-0000-0000-0000-000000000002'
   AND collection IN ('operation_additional_operators', 'session_additional_operators');
DELETE FROM directus_relations WHERE many_collection IN ('operation_additional_operators', 'session_additional_operators');
DELETE FROM directus_fields
 WHERE collection IN ('operation_additional_operators', 'session_additional_operators')
    OR (field = 'additional_operators' AND collection IN ('manufacturing_operations', 'test_sessions'));
DELETE FROM directus_collections WHERE collection IN ('operation_additional_operators', 'session_additional_operators');
DROP TABLE IF EXISTS session_additional_operators;
DROP TABLE IF EXISTS operation_additional_operators;
-- Restore merge_person to the migration-120 body: copy its CREATE OR REPLACE FUNCTION
-- statement verbatim from db/migrations/20261001000120_identity_cleanup.sql here.
```

Replace the final two-line comment under `-- migrate:down` with the `CREATE OR REPLACE FUNCTION merge_person` statement copied verbatim from migration 120.

- [ ] **Step 4: Apply, reload Directus, run the tests**

Run the dbmate `up` command, the Directus reload command, then `node --test tests/ownership/additional-operators.test.mjs tests/ownership/identity.test.mjs`.
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/20261001000122_additional_operators.sql tests/ownership/additional-operators.test.mjs
git commit -m "feat(db): additional operators on operations and test sessions"
```

---

### Task 4: Operator backfill from the curated mapping sheet

> Depends on Tasks 1 and 3A. Tasks 5–8 do not depend on this task; Task 9 does.

**Files:**
- Create: `scripts/operator_mapping_to_sql.py`
- Create: `tests/scripts/test_operator_mapping_to_sql.py`
- Create (generated): `db/migrations/20261001000123_operator_backfill.sql`
- Create: `tests/ownership/operator-backfill.test.mjs`

**Interfaces:**
- Consumes: sheet `Operators` (columns A `Operator id`, B `Name as recorded`, C `Operations`, E `Action`, F `Person (if MAP)`, G `New person name (if NEW)`, H `Researcher? (if NEW)`, M `Additional people (comma-separated, if MAP/NEW)`), header in row 1, data rows until column A is empty. People names after Task 1 (e.g. "Sam Lister"). Junction tables from Task 3A.
- Produces: `convert(xlsx_path) -> str` (full migration SQL); CLI `py -3 scripts/operator_mapping_to_sql.py <xlsx> <out.sql>`.

- [ ] **Step 1: Write the failing converter tests**

`tests/scripts/test_operator_mapping_to_sql.py`:
```python
import importlib.util
from pathlib import Path

import pytest
from openpyxl import Workbook

SPEC = importlib.util.spec_from_file_location(
    "opmap", Path(__file__).resolve().parents[2] / "scripts" / "operator_mapping_to_sql.py")
opmap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(opmap)


def sheet(tmp_path, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "Operators"
    ws.append(["Operator id", "Name as recorded", "Operations", "Active years", "Action",
               "Person (if MAP)", "New person name (if NEW)", "Researcher? (if NEW)",
               "Notes", "Why pre-filled", "Other spellings", "Already linked",
               "Additional people (comma-separated, if MAP/NEW)"])
    for r in rows:
        ws.append(r)
    ws.append([])
    ws.append([None, "Rows to decide", "=COUNTA(B2:B3)"])  # summary block must be ignored
    p = tmp_path / "m.xlsx"
    wb.save(p)
    return p


def test_map_new_ignore_and_blank(tmp_path):
    sql = opmap.convert(sheet(tmp_path, [
        [121, "Nick", 1151, "2020", "MAP", "Nick Weston", None, None],
        [126, "Nigel Martin", 611, "2021", "NEW", None, "Nigel Martin", "N"],
        [261, "Nigl", 4, "2023", "NEW", None, "nigel martin", None],
        [307, "X", 7, "2022", "IGNORE", None, None, None],
        [306, "Training", 1, "2022", None, None, None, None],
    ]))
    assert "(121, 'MAP', 'Nick Weston', NULL, false, '{}'::text[])" in sql
    assert "(126, 'NEW', NULL, 'Nigel Martin', false, '{}'::text[])" in sql
    assert "(261, 'NEW', NULL, 'nigel martin', false, '{}'::text[])" in sql
    assert "307" not in sql and "306" not in sql
    assert sql.startswith("-- migrate:up")
    assert "-- migrate:down" in sql


def test_additional_people_become_an_array(tmp_path):
    row = [142, "Sam Nigel", 7, "", "MAP", "Sam Lister", None, None,
           None, None, None, None, "Nigel Adams, Joe Hopkinson"]
    sql = opmap.convert(sheet(tmp_path, [row]))
    assert "(142, 'MAP', 'Sam Lister', NULL, false, ARRAY['Nigel Adams', 'Joe Hopkinson']::text[])" in sql
    assert "INSERT INTO operation_additional_operators" in sql
    assert "INSERT INTO session_additional_operators" in sql


def test_quotes_are_escaped(tmp_path):
    sql = opmap.convert(sheet(tmp_path, [[1, "O'Brien", 2, "", "NEW", None, "Pat O'Brien", "Y"]]))
    assert "'Pat O''Brien', true, '{}'::text[])" in sql


@pytest.mark.parametrize("row,msg", [
    ([1, "A", 1, "", "MAP", None, None, None], "MAP needs a person"),
    ([1, "A", 1, "", "NEW", None, None, None], "NEW needs a name"),
    ([1, "A", 1, "", "MAYBE", None, None, None], "unknown action"),
])
def test_invalid_rows_are_rejected(tmp_path, row, msg):
    with pytest.raises(ValueError, match=msg):
        opmap.convert(sheet(tmp_path, [row]))
```

- [ ] **Step 2: Run them to verify they fail**

Run: `py -3 -m pytest tests/scripts/test_operator_mapping_to_sql.py -q`
Expected: FAIL — `scripts/operator_mapping_to_sql.py` not found.

- [ ] **Step 3: Write the converter**

`scripts/operator_mapping_to_sql.py`:
```python
"""Convert the curated operator mapping sheet into a dbmate migration.

Usage: py -3 scripts/operator_mapping_to_sql.py db/mappings/operator-mapping.xlsx \
           db/migrations/20261001000123_operator_backfill.sql
"""
import sys

from openpyxl import load_workbook

ACTIONS = {"MAP", "NEW", "IGNORE"}


def lit(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def read_rows(path):
    ws = load_workbook(path, data_only=True)["Operators"]
    rows = []
    for r in range(2, ws.max_row + 1):
        op_id = ws.cell(r, 1).value
        if op_id is None or not str(op_id).strip().isdigit():
            break
        rows.append({
            "id": int(op_id),
            "name": ws.cell(r, 2).value,
            "action": (str(ws.cell(r, 5).value or "").strip().upper() or "IGNORE"),
            "person": (str(ws.cell(r, 6).value).strip() if ws.cell(r, 6).value else None),
            "new": (str(ws.cell(r, 7).value).strip() if ws.cell(r, 7).value else None),
            "researcher": str(ws.cell(r, 8).value or "").strip().upper() == "Y",
            "additional": [p.strip() for p in str(ws.cell(r, 13).value or "").split(",") if p.strip()],
        })
    return rows


def arr(names):
    if not names:
        return "'{}'::text[]"
    return "ARRAY[" + ", ".join(lit(n) for n in names) + "]::text[]"


def convert(path):
    values = []
    for row in read_rows(path):
        a = row["action"]
        if a not in ACTIONS:
            raise ValueError(f"row {row['id']} ({row['name']}): unknown action {a!r}")
        if a == "IGNORE":
            continue
        if a == "MAP" and not row["person"]:
            raise ValueError(f"row {row['id']} ({row['name']}): MAP needs a person")
        if a == "NEW" and not row["new"]:
            raise ValueError(f"row {row['id']} ({row['name']}): NEW needs a name")
        person = row["person"] if a == "MAP" else None
        new = row["new"] if a == "NEW" else None
        researcher = "true" if (a == "NEW" and row["researcher"]) else "false"
        values.append(f"({row['id']}, {lit(a)}, {lit(person)}, {lit(new)}, {researcher}, {arr(row['additional'])})")
    body = ",\n    ".join(values) if values else "(NULL::int, NULL, NULL, NULL, false, '{}'::text[])"
    return f"""-- migrate:up
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
    {body};
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
"""


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    sql = convert(src)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(sql)
    print(f"wrote {out}")
```

- [ ] **Step 4: Run the converter tests to verify they pass**

Run: `py -3 -m pytest tests/scripts/test_operator_mapping_to_sql.py -q`
Expected: 6 passed.

- [ ] **Step 5: Write the failing backfill test**

`tests/ownership/operator-backfill.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sqlOne } from './lib.mjs';

// Expected count comes straight from the filled sheet (MAP/NEW rows' operations).
const expected = Number(execFileSync('py', ['-3', '-c', `
from openpyxl import load_workbook
ws = load_workbook('db/mappings/operator-mapping.xlsx', data_only=True)['Operators']
n = 0
for r in range(2, ws.max_row + 1):
    a, c = ws.cell(r, 1).value, ws.cell(r, 3).value
    if a is None or not str(a).strip().isdigit(): break
    if str(ws.cell(r, 5).value or '').strip().upper() in ('MAP', 'NEW'): n += int(c)
print(n)`], { encoding: 'utf8' }).trim());

test('every MAP/NEW operator row now links its operations to a person', () => {
	const linked = Number(sqlOne(`SELECT count(*) FROM manufacturing_operations
		WHERE operator IS NOT NULL AND operator_person_id IS NOT NULL
		  AND operator IN (SELECT id FROM "Machine_Operators")`));
	assert.ok(linked >= expected, `linked ${linked} >= expected ${expected}`);
});

// [[machine_operator_id, [additional names]]] for MAP/NEW rows that list additional people.
const multi = JSON.parse(execFileSync('py', ['-3', '-c', `
import json
from openpyxl import load_workbook
ws = load_workbook('db/mappings/operator-mapping.xlsx', data_only=True)['Operators']
out = []
for r in range(2, ws.max_row + 1):
    a = ws.cell(r, 1).value
    if a is None or not str(a).strip().isdigit(): break
    if str(ws.cell(r, 5).value or '').strip().upper() not in ('MAP', 'NEW'): continue
    extra = [p.strip() for p in str(ws.cell(r, 13).value or '').split(',') if p.strip()]
    if extra: out.append([int(a), extra])
print(json.dumps(out))`], { encoding: 'utf8' }).trim());

test('multi-person rows put every extra person on each operation as an additional operator', () => {
	assert.ok(multi.length > 0, 'sheet has multi-person rows');
	for (const [opId, names] of multi) {
		for (const name of names) {
			const missing = sqlOne(`SELECT count(*) FROM manufacturing_operations o
				WHERE o.operator = ${opId}
				  AND NOT EXISTS (SELECT 1 FROM operation_additional_operators x JOIN people p ON p.person_id = x.person_id
				                  WHERE x.operation_id = o.operation_id AND lower(p.full_name) = lower('${name.replace(/'/g, "''")}'))`);
			assert.equal(missing, '0', `operator ${opId} missing additional ${name}`);
		}
	}
});

test('operator_name text is untouched for every operation', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM manufacturing_operations WHERE operator IS NOT NULL AND nullif(trim(operator_name), '') IS NULL`), '0');
});
```

- [ ] **Step 6: Generate the migration from the filled sheet and apply it**

```bash
py -3 scripts/operator_mapping_to_sql.py db/mappings/operator-mapping.xlsx db/migrations/20261001000123_operator_backfill.sql
```
Then run the dbmate `up` command. Expected: `Applied: 20261001000123_operator_backfill.sql`. If it raises `names missing or ambiguous`, fix those rows in the sheet with Dennis and regenerate. (As curated on 2026-10-01 the sheet validates cleanly: 48 MAP + 4 NEW rows → 2,689 operations, 3 new people: Ben Thomas, Connor McCarthy, Kyle Marshall; 3 multi-person rows.)

- [ ] **Step 7: Run the backfill test**

Run: `node --test tests/ownership/operator-backfill.test.mjs`
Expected: 3 passing.

- [ ] **Step 8: Commit**

```bash
git add scripts/operator_mapping_to_sql.py tests/scripts/test_operator_mapping_to_sql.py db/migrations/20261001000123_operator_backfill.sql db/mappings/operator-mapping.xlsx tests/ownership/operator-backfill.test.mjs
git commit -m "feat(db): link historical operators to people from the curated mapping"
```

---

### Task 5: `created_by` on every ownable collection

**Files:**
- Create: `db/migrations/20261001000124_created_by.sql`
- Create: `tests/ownership/created-by.test.mjs`

**Interfaces:**
- Consumes: `createUser`, `personOf`, `deleteUser`, `api`, `adminToken` (Tasks 1–2); `login_aliases` (Task 1).
- Produces: column `created_by uuid` (→ `directus_users`, `ON DELETE SET NULL`) on the 10 ownable tables, Directus `special = 'user-created'`, read-only.

- [ ] **Step 1: Write the failing tests**

`tests/ownership/created-by.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sqlOne } from './lib.mjs';

const TABLES = ['physical_samples', 'tool_boxes', 'cutting_inserts', 'insert_edges', 'etchants', 'prep_recipes',
	'campaigns', 'manufacturing_operations', 'test_sessions', 'projects'];

for (const t of TABLES) {
	test(`${t} has a created_by column`, () => {
		assert.equal(sqlOne(`SELECT count(*) FROM information_schema.columns WHERE table_name = '${t}' AND column_name = 'created_by'`), '1');
	});
}

test('created_by is stamped from the login and survives an owner change', async () => {
	const admin = await adminToken();
	const jozef = await createUser(admin, 'Jozefish');
	const dennis = await createUser(admin, 'Dennisish');
	let sampleId;
	try {
		const r = await api('POST', '/items/physical_samples', jozef.token, { sample_code: `CB-${Date.now()}` });
		assert.equal(r.status, 200, JSON.stringify(r.data));
		sampleId = r.data.data.sample_id;
		assert.equal(r.data.data.created_by, jozef.userId);
		const u = await api('PATCH', `/items/physical_samples/${sampleId}`, jozef.token, { owner_person_id: personOf(dennis.userId) });
		assert.equal(u.status, 200, JSON.stringify(u.data));
		assert.equal(sqlOne(`SELECT created_by FROM physical_samples WHERE sample_id = '${sampleId}'`), jozef.userId);
	} finally {
		if (sampleId) await api('DELETE', `/items/physical_samples/${sampleId}`, admin);
		await deleteUser(admin, jozef.userId);
		await deleteUser(admin, dennis.userId);
	}
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/ownership/created-by.test.mjs`
Expected: FAIL — no `created_by` column.

- [ ] **Step 3: Write the migration**

`db/migrations/20261001000124_created_by.sql`:
```sql
-- migrate:up
-- Permanent, read-only "created by" (the login) on every ownable collection,
-- separate from the editable owner. Historical rows are filled from the audit
-- log's INSERT entries where it recorded a real login; otherwise left NULL.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT * FROM (VALUES
        ('physical_samples', 'sample_id'), ('tool_boxes', 'tool_box_id'), ('cutting_inserts', 'insert_id'),
        ('insert_edges', 'edge_id'), ('etchants', 'etchant_id'), ('prep_recipes', 'recipe_id'),
        ('campaigns', 'campaign_id'), ('manufacturing_operations', 'operation_id'),
        ('test_sessions', 'session_id'), ('projects', 'project_id')
    ) v(tbl, pk) LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES directus_users(id) ON DELETE SET NULL', r.tbl);
        EXECUTE format($f$
            UPDATE %1$I x SET created_by = COALESCE(a.canonical_user_id, u.id)
              FROM audit_logs l
              JOIN directus_users u ON u.id::text = l.actor_identity
              LEFT JOIN login_aliases a ON a.alias_user_id = u.id
             WHERE x.created_by IS NULL
               AND l.table_name = %2$L AND l.action_type = 'INSERT'
               AND l.row_after ->> %3$L = x.%3$I::text
        $f$, r.tbl, r.tbl, r.pk);

        INSERT INTO directus_fields (collection, field, special, interface, options, display, display_options,
                                     readonly, hidden, sort, width, required, translations)
        SELECT r.tbl, 'created_by', 'user-created', 'select-dropdown-m2o',
               '{"template":"{{first_name}} {{last_name}}"}', 'user', NULL,
               true, false, 98, 'half', false, '[{"language":"en-US","translation":"Created by"}]'
        WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = r.tbl AND f.field = 'created_by');

        INSERT INTO directus_relations (many_collection, many_field, one_collection, one_deselect_action)
        SELECT r.tbl, 'created_by', 'directus_users', 'nullify'
        WHERE NOT EXISTS (SELECT 1 FROM directus_relations x WHERE x.many_collection = r.tbl AND x.many_field = 'created_by');
    END LOOP;
END $$;

-- migrate:down
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['physical_samples','tool_boxes','cutting_inserts','insert_edges','etchants',
                             'prep_recipes','campaigns','manufacturing_operations','test_sessions','projects'] LOOP
        DELETE FROM directus_relations WHERE many_collection = t AND many_field = 'created_by';
        DELETE FROM directus_fields WHERE collection = t AND field = 'created_by';
        EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS created_by', t);
    END LOOP;
END $$;
```

- [ ] **Step 4: Apply and reload Directus**

Run the dbmate `up` command, then the Directus reload command.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/ownership/created-by.test.mjs`
Expected: 11 passing.

- [ ] **Step 6: Mirror in configure_directus.sql and commit**

In `scripts/configure_directus.sql`, in each `INSERT INTO directus_fields` block for `physical_samples`, `tool_boxes`, `cutting_inserts`, `insert_edges`, `manufacturing_operations`, `test_sessions` and `projects`, add a row before the block's `created_at` row:
```sql
('<collection>','created_by','user-created','select-dropdown-m2o','{"template":"{{first_name}} {{last_name}}"}','user',NULL,true,false,98,'half',false,'[{"language":"en-US","translation":"Created by"}]'),
```
(`campaigns`, `etchants`, `prep_recipes` are configured in `scripts/configure_campaigns.sql` / `scripts/configure_sample_prep.sql`; add the same row in their `directus_fields` inserts, matching each file's column list.)

```bash
git add db/migrations/20261001000124_created_by.sql tests/ownership/created-by.test.mjs scripts/configure_directus.sql scripts/configure_campaigns.sql scripts/configure_sample_prep.sql
git commit -m "feat(db): read-only created_by on every ownable collection"
```

---

### Task 6: Server backstop — owner defaults to the login

**Files:**
- Create: `core/extensions/d1-owner-default/index.js`
- Create: `core/extensions/d1-owner-default/package.json`
- Delete: `core/extensions/d1-default-owner/` (whole directory)
- Modify: `core/extensions/campaign-inherit/index.js` (remove owner inheritance)
- Modify: `tests/ui/specs/09-campaign-inheritance.spec.ts:74` (comment)
- Create: `tests/ownership/owner-default.test.mjs`

**Interfaces:**
- Consumes: `createUser`, `personOf`, `deleteUser`, `api`, `sql`, `sqlOne`, `adminToken`.
- Produces: `OWNER_FIELDS` map (exported from `d1-owner-default/index.js`) — the same collection→field map Task 8 configures.

- [ ] **Step 1: Write the failing tests**

`tests/ownership/owner-default.test.mjs`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

let admin, a, b, methodId, techId;
const cleanup = [];

before(async () => {
	admin = await adminToken();
	a = await createUser(admin, 'OwnerA');
	b = await createUser(admin, 'OwnerB');
	methodId = sqlOne(`SELECT method_id FROM manufacturing_methods WHERE method_code = 'MT'`);
	techId = sqlOne(`INSERT INTO people (full_name, is_operator) VALUES ('OwnTest Technician ${Date.now()}', true) RETURNING person_id`);
});

after(async () => {
	for (const [col, id] of cleanup.reverse()) await api('DELETE', `/items/${col}/${id}`, admin);
	sql(`DELETE FROM people WHERE person_id = '${techId}'`);
	await deleteUser(admin, a.userId);
	await deleteUser(admin, b.userId);
});

async function create(token, collection, body, pk) {
	const r = await api('POST', `/items/${collection}`, token, body);
	assert.equal(r.status, 200, JSON.stringify(r.data));
	cleanup.push([collection, r.data.data[pk]]);
	return r.data.data;
}

test('blank owner is filled with the logged-in researcher', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `OD-${Date.now()}` }, 'sample_id');
	assert.equal(s.owner_person_id, personOf(a.userId));
});

test('explicit null owner is filled from login', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `ODN-${Date.now()}`, owner_person_id: null }, 'sample_id');
	assert.equal(s.owner_person_id, personOf(a.userId));
});

test('an explicitly chosen owner is kept', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `ODX-${Date.now()}`, owner_person_id: personOf(b.userId) }, 'sample_id');
	assert.equal(s.owner_person_id, personOf(b.userId));
});

test('login wins over the campaign owner; project is still inherited', async () => {
	const project = sqlOne(`SELECT project_id FROM projects LIMIT 1`);
	const c = await create(b.token, 'campaigns', { project_id: project, campaign_type: 'machining_trial', name: `OD-C-${Date.now()}` }, 'campaign_id');
	assert.equal(c.owner_person_id, personOf(b.userId));
	const op = await create(a.token, 'manufacturing_operations', { method_id: methodId, campaign_id: c.campaign_id }, 'operation_id');
	assert.equal(op.owner_person_id, personOf(a.userId));
	assert.equal(op.project_id, project);
});

test('force-app-shaped operation: owner from login, operator preserved', async () => {
	const op = await create(a.token, 'manufacturing_operations', {
		method_id: methodId, operator_person_id: techId, process_category: 'machining',
		capture_software: 'force-app', machining_force_captured: true,
	}, 'operation_id');
	assert.equal(op.owner_person_id, personOf(a.userId));
	assert.equal(op.operator_person_id, techId);
});

test('projects: PI defaults to the login', async () => {
	const p = await create(a.token, 'projects', { project_name: `OD-P-${Date.now()}` }, 'project_id');
	assert.equal(p.principal_investigator_person, personOf(a.userId));
});

test('machine-like login leaves owner blank', async () => {
	const m = await createUser(admin, 'Machine');
	sql(`UPDATE people SET is_researcher = false WHERE user_id = '${m.userId}'`);
	try {
		const s = await create(m.token, 'physical_samples', { sample_code: `ODM-${Date.now()}` }, 'sample_id');
		assert.equal(s.owner_person_id, null);
	} finally { await deleteUser(admin, m.userId); }
});

test('PATCH keeps a non-researcher owner', async () => {
	const s = await create(a.token, 'physical_samples', { sample_code: `ODP-${Date.now()}` }, 'sample_id');
	sql(`UPDATE physical_samples SET owner_person_id = '${techId}' WHERE sample_id = '${s.sample_id}'`);
	const r = await api('PATCH', `/items/physical_samples/${s.sample_id}`, a.token, { nickname: 'edited' });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	assert.equal(sqlOne(`SELECT owner_person_id FROM physical_samples WHERE sample_id = '${s.sample_id}'`), techId);
});
```

- [ ] **Step 2: Run to verify the new-behaviour tests fail**

Run: `node --test tests/ownership/owner-default.test.mjs`
Expected: FAIL on `blank owner is filled…` (physical_samples isn't covered by `d1-default-owner`) and `login wins over the campaign owner` (campaign-inherit copies B).

- [ ] **Step 3: Write the backstop hook**

`core/extensions/d1-owner-default/package.json`:
```json
{
  "name": "directus-extension-d1-owner-default",
  "version": "1.0.0",
  "type": "module",
  "description": "Owner defaults to the logged-in researcher on create when left blank (login wins).",
  "keywords": ["directus", "directus-extension", "directus-custom-hook"],
  "directus:extension": {
    "type": "hook",
    "path": "index.js",
    "source": "index.js",
    "host": "^11.0.0"
  }
}
```

`core/extensions/d1-owner-default/index.js`:
```js
// Directus hook: d1-owner-default
//
// "Login wins": a new record's owner defaults to the logged-in user's person
// when the caller leaves it blank (omitted, null or ''). Covers the force app,
// API scripts and bulk writes that don't go through the d1-owner-picker form
// interface. Logins without a linked *researcher* person (machine tokens) leave
// the owner blank rather than failing the write. Explicit choices always win.

export const OWNER_FIELDS = {
	physical_samples: 'owner_person_id',
	tool_boxes: 'owner_person_id',
	cutting_inserts: 'owner_person_id',
	insert_edges: 'owner_person_id',
	etchants: 'owner_person_id',
	prep_recipes: 'owner_person_id',
	campaigns: 'owner_person_id',
	manufacturing_operations: 'owner_person_id',
	test_sessions: 'owner_person_id',
	projects: 'principal_investigator_person',
};

const isBlank = (v) => v === undefined || v === null || v === '';

export default ({ filter }) => {
	filter('items.create', async (payload, meta, context) => {
		const field = OWNER_FIELDS[meta?.collection];
		if (!field || !payload || !isBlank(payload[field])) return payload;
		const user = context?.accountability?.user;
		const db = context?.database;
		if (!user || !db) return payload;
		const person = await db('people').where({ user_id: user, is_researcher: true }).first('person_id');
		if (person) payload[field] = person.person_id;
		return payload;
	});
};
```

- [ ] **Step 4: Remove the old default-owner hook and campaign owner inheritance**

```bash
git rm -r core/extensions/d1-default-owner
```

In `core/extensions/campaign-inherit/index.js`, replace the header comment and the two owner blocks so the file reads:
```js
// Directus hook: campaign-inherit
//
// Campaigns (machining trials / testing campaigns) group children under a project
// and carry defaults. When a child is created with a campaign set, it inherits the
// campaign's project, default equipment and (for operations) default material so
// the user doesn't re-enter them. Ownership is NOT inherited: the owner defaults to
// the logged-in user (d1-owner-default); inheriting it is an explicit
// "same as parent" choice in the form (d1-owner-picker).

const CHILD_COLLECTIONS = new Set(['manufacturing_operations', 'test_sessions']);

const isBlank = (v) => v === undefined || v === null || v === '';

export default ({ filter }) => {
  filter('items.create', async (payload, meta, context) => {
    const collection = meta?.collection;
    const db = context?.database;
    if (!db || !payload) return payload;

    if (CHILD_COLLECTIONS.has(collection) && !isBlank(payload.campaign_id)) {
      const campaign = await db('campaigns')
        .where('campaign_id', payload.campaign_id)
        .select('project_id', 'default_equipment_id', 'default_material_id')
        .first();
      if (campaign) {
        if (isBlank(payload.project_id) && campaign.project_id) payload.project_id = campaign.project_id;
        if (isBlank(payload.equipment_id) && campaign.default_equipment_id) {
          payload.equipment_id = campaign.default_equipment_id;
        }
        // Only manufacturing_operations carries a material column.
        if (collection === 'manufacturing_operations'
          && isBlank(payload.material_id) && campaign.default_material_id) {
          payload.material_id = campaign.default_material_id;
        }
      }
    }

    return payload;
  });
};
```

In `tests/ui/specs/09-campaign-inheritance.spec.ts`, change the header comment line `* owner and default equipment/material (server hook \`campaign-inherit\`); the project` to `* default equipment/material (server hook \`campaign-inherit\`); owner comes from the login; the project`, and line 74's comment to `// owner defaults to the logged-in user's person (d1-owner-default)`. Rename the test title `inherits project + owner + equipment` to `inherits project + equipment`.

- [ ] **Step 5: Reload Directus and run the tests**

Run the reload command, then: `node --test tests/ownership/owner-default.test.mjs tests/ownership/created-by.test.mjs`
Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add core/extensions/d1-owner-default core/extensions/campaign-inherit/index.js tests/ui/specs/09-campaign-inheritance.spec.ts tests/ownership/owner-default.test.mjs
git commit -m "feat(directus): owner defaults to the logged-in researcher; stop inheriting owner from campaigns"
```

---

### Task 7: Bulk intake sets the batch owner explicitly

**Files:**
- Create: `db/migrations/20261001000125_intake_owner_explicit.sql`
- Create: `tests/ownership/intake-owner.test.mjs`

**Interfaces:**
- Consumes: `expand_tool_box_intake(uuid)`, `fill_cutting_insert_code()`, `fill_insert_edge_code()` as defined in `db/migrations/20260930000114_intake_expansion_and_code_generation.sql` (up section).
- Produces: intake-generated inserts/edges get `owner_person_id = <first box's owner_person_id>`; triggers no longer set `owner_person_id`; the clone INSERT no longer references the legacy `owner` column (needed before Task 9 drops it).

- [ ] **Step 1: Write the failing tests**

`tests/ownership/intake-owner.test.mjs`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sql, sqlOne } from './lib.mjs';

let admin, a, b, typeId;
const boxes = [];

before(async () => {
	admin = await adminToken();
	a = await createUser(admin, 'IntakeA');
	b = await createUser(admin, 'IntakeB');
	const r = await api('POST', '/items/insert_types', admin, { type_code: `OWNTEST-${Date.now()}`, short_code: `OT${Date.now() % 100000}`, inserts_per_box: 3, edge_count: 2 });
	typeId = r.data.data.insert_type_id;
});

after(async () => {
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
	await api('DELETE', `/items/insert_types/${typeId}`, admin);
	await deleteUser(admin, a.userId);
	await deleteUser(admin, b.userId);
});

async function intake(token, body) {
	const r = await api('POST', '/items/tool_boxes', token, { insert_type_id: typeId, package_quantity: 2, ...body });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	await new Promise((res) => setTimeout(res, 1500));
	return r.data.data.tool_box_id;
}

function owners(firstBoxId) {
	const code = sqlOne(`SELECT split_part(tool_box_code, '-', 1) FROM tool_boxes WHERE tool_box_id = '${firstBoxId}'`);
	return sql(`
		SELECT DISTINCT owner_person_id FROM tool_boxes WHERE insert_type_id = '${typeId}' AND tool_box_code LIKE '${code}-%'
		UNION SELECT DISTINCT ci.owner_person_id FROM cutting_inserts ci JOIN tool_boxes tb ON tb.tool_box_id = ci.tool_box_id WHERE tb.insert_type_id = '${typeId}'
		UNION SELECT DISTINCT ie.owner_person_id FROM insert_edges ie JOIN cutting_inserts ci ON ci.insert_id = ie.insert_id JOIN tool_boxes tb ON tb.tool_box_id = ci.tool_box_id WHERE tb.insert_type_id = '${typeId}'
	`).map((r) => r[0]);
}

test('intake with chosen owner carries it to every row', async () => {
	const first = await intake(a.token, { owner_person_id: personOf(b.userId) });
	assert.deepEqual(owners(first), [personOf(b.userId)]);
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
});

test('intake without an owner uses the login for every row', async () => {
	const first = await intake(a.token, {});
	assert.deepEqual(owners(first), [personOf(a.userId)]);
	sql(`DELETE FROM tool_boxes WHERE insert_type_id = '${typeId}'`);
});

test("a manual insert in someone else's box is owned by the login, not the box owner", async () => {
	const first = await intake(b.token, {});
	const r = await api('POST', '/items/cutting_inserts', a.token, { tool_box_id: first });
	assert.equal(r.status, 200, JSON.stringify(r.data));
	assert.equal(r.data.data.owner_person_id, personOf(a.userId));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test tests/ownership/intake-owner.test.mjs`
Expected: FAIL on the manual-insert test (trigger copies the box owner B). The chosen-owner test may already pass via the trigger; that's fine.

- [ ] **Step 3: Write the migration**

`db/migrations/20261001000125_intake_owner_explicit.sql`:
```sql
-- migrate:up
-- Bulk intake: the intake form's owner is the explicit choice for the whole
-- batch, so expand_tool_box_intake sets owner_person_id on every generated
-- box, insert and edge itself. The code-filling triggers stop making
-- ownership decisions (a manual insert/edge is owned by the login via the
-- d1-owner-default hook, not by its parent). The clone INSERT no longer
-- copies the legacy login-based owner column.

CREATE OR REPLACE FUNCTION expand_tool_box_intake(p_first_box_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_box          tool_boxes%ROWTYPE;
    v_it           insert_types%ROWTYPE;
    v_short_code   TEXT;
    v_base_seq     INTEGER;
    v_box_seq      INTEGER;
    v_box_id       UUID;
    v_box_code     TEXT;
    v_insert_id    UUID;
    v_insert_code  TEXT;
    v_edge_letters TEXT[] := ARRAY[
        'A','B','C','D','E','F','G','H','I','J',
        'K','L','M','N','O','P','Q','R','S','T'
    ];
    v_ins_num      INTEGER;
    v_edge_idx     INTEGER;
BEGIN
    SELECT * INTO v_box FROM tool_boxes WHERE tool_box_id = p_first_box_id;
    IF NOT FOUND OR v_box.insert_type_id IS NULL THEN
        RETURN;
    END IF;

    SELECT * INTO v_it
    FROM   insert_types
    WHERE  insert_type_id = v_box.insert_type_id
    FOR UPDATE;

    v_short_code := COALESCE(
        NULLIF(TRIM(v_it.short_code), ''),
        generate_insert_short_code(v_it.type_code)
    );
    IF v_short_code IS NULL OR v_short_code = '' THEN
        RAISE EXCEPTION 'expand_tool_box_intake: cannot derive short_code for insert_type %', v_box.insert_type_id;
    END IF;

    -- Highest number ever used under this short_code prefix (tool_box_code's
    -- uniqueness domain), so deleted boxes or shared prefixes never collide.
    SELECT COALESCE(MAX((regexp_match(tool_box_code, '-(\d+)$'))[1]::INTEGER), 0)
    INTO   v_base_seq
    FROM   tool_boxes
    WHERE  tool_box_code LIKE v_short_code || '-%'
      AND  tool_box_id   <> p_first_box_id;

    FOR v_box_seq IN 1 .. GREATEST(COALESCE(v_box.package_quantity, 1), 1) LOOP

        v_box_code := v_short_code || '-' || (v_base_seq + v_box_seq);

        IF v_box_seq = 1 THEN
            UPDATE tool_boxes
            SET    tool_box_code = v_box_code
            WHERE  tool_box_id   = p_first_box_id;
            v_box_id := p_first_box_id;
        ELSE
            -- package_quantity = 0 prevents the box-intake hook re-expanding clones.
            v_box_id := uuid_generate_v4();
            INSERT INTO tool_boxes (
                tool_box_id,   tool_box_code,      insert_type_id,
                description,   location,           notes,
                package_quantity, project_id,      owner_person_id
            ) VALUES (
                v_box_id,      v_box_code,         v_box.insert_type_id,
                v_box.description, v_box.location, v_box.notes,
                0,             v_box.project_id,   v_box.owner_person_id
            );
        END IF;

        FOR v_ins_num IN 1 .. GREATEST(COALESCE(v_it.inserts_per_box, 0), 0) LOOP
            v_insert_id   := uuid_generate_v4();
            v_insert_code := v_box_code || '-' || v_ins_num;

            INSERT INTO cutting_inserts (
                insert_id,      insert_code,   tool_box_id,
                insert_type_id, insert_number, owner_person_id
            ) VALUES (
                v_insert_id,          v_insert_code, v_box_id,
                v_box.insert_type_id, v_ins_num,     v_box.owner_person_id
            );

            FOR v_edge_idx IN 1 .. GREATEST(COALESCE(v_it.edge_count, 0), 0) LOOP
                INSERT INTO insert_edges (
                    edge_id,   edge_code,
                    insert_id, edge_identifier, owner_person_id
                ) VALUES (
                    uuid_generate_v4(),
                    v_insert_code || v_edge_letters[v_edge_idx],
                    v_insert_id,
                    v_edge_letters[v_edge_idx],
                    v_box.owner_person_id
                );
            END LOOP;
        END LOOP;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION fill_cutting_insert_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_box_code TEXT;
BEGIN
    IF NEW.insert_number IS NULL THEN
        SELECT COALESCE(MAX(insert_number), 0) + 1 INTO NEW.insert_number
        FROM   cutting_inserts
        WHERE  tool_box_id = NEW.tool_box_id;
    END IF;
    IF NEW.insert_code IS NULL OR NEW.insert_code = '' OR NEW.insert_code LIKE 'TMP-%' THEN
        SELECT tool_box_code INTO v_box_code FROM tool_boxes WHERE tool_box_id = NEW.tool_box_id;
        NEW.insert_code := COALESCE(v_box_code, 'BOX') || '-' || NEW.insert_number;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION fill_insert_edge_code()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_insert_code TEXT;
    v_edge_count  INTEGER;
BEGIN
    IF NEW.edge_identifier IS NULL OR NEW.edge_identifier = '' THEN
        SELECT COUNT(*) INTO v_edge_count FROM insert_edges WHERE insert_id = NEW.insert_id;
        NEW.edge_identifier := CHR(65 + v_edge_count);
    END IF;
    IF NEW.edge_code IS NULL OR NEW.edge_code = '' OR NEW.edge_code LIKE 'TMP-%' THEN
        SELECT insert_code INTO v_insert_code FROM cutting_inserts WHERE insert_id = NEW.insert_id;
        NEW.edge_code := COALESCE(v_insert_code, 'INS') || NEW.edge_identifier;
    END IF;
    RETURN NEW;
END;
$$;

-- migrate:down
-- Restore the migration-114 bodies: copy the three CREATE OR REPLACE FUNCTION
-- statements for expand_tool_box_intake, fill_cutting_insert_code and
-- fill_insert_edge_code verbatim from the `-- migrate:up` section of
-- db/migrations/20260930000114_intake_expansion_and_code_generation.sql
-- here (they include the owner-from-parent branches and the legacy owner column).
```

Replace the three-line comment under `-- migrate:down` with those three statements copied verbatim from migration 114's up section (lines from `CREATE OR REPLACE FUNCTION expand_tool_box_intake` to its `$$;`, and likewise for `fill_cutting_insert_code` and `fill_insert_edge_code`).

- [ ] **Step 4: Apply and run the tests**

Run the dbmate `up` command, then `node --test tests/ownership/intake-owner.test.mjs`.
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/20261001000125_intake_owner_explicit.sql tests/ownership/intake-owner.test.mjs
git commit -m "feat(db): bulk intake sets the batch owner explicitly; triggers stop inheriting owners"
```

---

### Task 8: `d1-owner-picker` form interface

**Files:**
- Create: `core/extensions/d1-owner-picker/package.json`
- Create: `core/extensions/d1-owner-picker/src/index.ts`
- Create: `core/extensions/d1-owner-picker/src/OwnerPicker.vue`
- Create: `db/migrations/20261001000126_owner_picker_fields.sql`
- Create: `tests/ui/specs/10-owner-picker.spec.ts`
- Create: `tests/ownership/owner-picker-meta.test.mjs`

**Interfaces:**
- Consumes: `OWNER_FIELDS` mapping (Task 6) — same collections/fields.
- Produces: interface id `d1-owner-picker`, options `{ parentField?: string, parentCollection?: string, parentOwnerField?: string }`.

- [ ] **Step 1: Write the failing metadata test**

`tests/ownership/owner-picker-meta.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from './lib.mjs';

const EXPECT = {
	physical_samples: ['owner_person_id', null], tool_boxes: ['owner_person_id', null],
	cutting_inserts: ['owner_person_id', 'tool_box_id'], insert_edges: ['owner_person_id', 'insert_id'],
	etchants: ['owner_person_id', null], prep_recipes: ['owner_person_id', null],
	campaigns: ['owner_person_id', 'project_id'], manufacturing_operations: ['owner_person_id', 'campaign_id'],
	test_sessions: ['owner_person_id', 'campaign_id'], projects: ['principal_investigator_person', null],
};

for (const [collection, [field, parent]] of Object.entries(EXPECT)) {
	test(`${collection}.${field} uses d1-owner-picker`, () => {
		const [[iface, opts]] = sql(`SELECT interface, coalesce(options::text, '{}') FROM directus_fields WHERE collection = '${collection}' AND field = '${field}'`);
		assert.equal(iface, 'd1-owner-picker');
		assert.equal(JSON.parse(opts).parentField ?? null, parent);
	});
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/ownership/owner-picker-meta.test.mjs`
Expected: FAIL — interface is `select-dropdown-m2o`.

- [ ] **Step 3: Write the interface**

`core/extensions/d1-owner-picker/package.json`:
```json
{
  "name": "directus-extension-d1-owner-picker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "directus-extension build",
    "dev": "directus-extension build --watch"
  },
  "devDependencies": {
    "@directus/extensions-sdk": "^17",
    "@vue/compiler-sfc": "^3",
    "typescript": "^5",
    "vue": "^3"
  },
  "directus:extension": {
    "type": "interface",
    "path": "dist/index.js",
    "source": "src/index.ts",
    "host": "^11.0.0"
  }
}
```

`core/extensions/d1-owner-picker/src/index.ts`:
```ts
import { defineInterface } from '@directus/extensions-sdk';
import OwnerPicker from './OwnerPicker.vue';

export default defineInterface({
	id: 'd1-owner-picker',
	name: 'Owner (researcher)',
	icon: 'person',
	description: 'Researcher-only owner dropdown. Prefilled with you on new items; optional "same as parent".',
	component: OwnerPicker,
	types: ['uuid'],
	localTypes: ['m2o'],
	group: 'relational',
	relational: true,
	options: [
		{ field: 'parentField', name: 'Parent field (on this item)', type: 'string', meta: { width: 'third', interface: 'input' } },
		{ field: 'parentCollection', name: 'Parent collection', type: 'string', meta: { width: 'third', interface: 'input' } },
		{ field: 'parentOwnerField', name: "Parent's owner field", type: 'string', meta: { width: 'third', interface: 'input' } },
	],
});
```

`core/extensions/d1-owner-picker/src/OwnerPicker.vue`:
```vue
<template>
	<div class="d1-owner-picker">
		<v-select
			:items="items"
			:model-value="value"
			:disabled="disabled || sameAsParent"
			placeholder="Select an owner…"
			show-deselect
			:search="true"
			@update:model-value="emit('input', $event)"
		/>
		<v-checkbox
			v-if="parentField"
			v-model="sameAsParent"
			class="same"
			label="Same as parent"
			:disabled="disabled"
		/>
	</div>
</template>

<script setup lang="ts">
import { inject, ref, computed, watch, onMounted, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';

const props = defineProps<{
	value: string | null;
	primaryKey?: string | number;
	disabled?: boolean;
	parentField?: string;
	parentCollection?: string;
	parentOwnerField?: string;
}>();
const emit = defineEmits<{ (e: 'input', value: string | null): void }>();

const api = useApi();
const values = inject<Ref<Record<string, any>>>('values', ref({}));
const items = ref<{ text: string; value: string }[]>([]);
const sameAsParent = ref(false);
const isNew = computed(() => props.primaryKey === '+' || props.primaryKey === undefined);

function idOf(v: any): string | null {
	if (!v) return null;
	return typeof v === 'object' ? (v.id ?? v[Object.keys(v)[0]] ?? null) : String(v);
}

async function loadResearchers() {
	const res = await api.get('/items/people', {
		params: {
			filter: { _and: [{ is_researcher: { _eq: true } }, { user_id: { _nnull: true } }] },
			fields: ['person_id', 'full_name'], sort: 'full_name', limit: -1,
		},
	});
	items.value = (res?.data?.data ?? []).map((p: any) => ({ text: p.full_name, value: p.person_id }));
}

// An owner that isn't in the researcher list (legacy data, or a parent's
// non-researcher owner) must still display rather than show a blank.
async function ensureListed(id: string | null) {
	if (!id || items.value.some((i) => i.value === id)) return;
	try {
		const res = await api.get(`/items/people/${id}`, { params: { fields: ['person_id', 'full_name'] } });
		const p = res?.data?.data;
		if (p) items.value = [{ text: `${p.full_name} (not a researcher)`, value: p.person_id }, ...items.value];
	} catch { /* leave as-is */ }
}

async function prefillMe() {
	if (!isNew.value || props.value) return;
	const res = await api.get('/items/people', {
		params: { filter: { _and: [{ user_id: { _eq: '$CURRENT_USER' } }, { is_researcher: { _eq: true } }] }, fields: ['person_id'], limit: 1 },
	});
	const me = res?.data?.data?.[0]?.person_id;
	if (me && !props.value) emit('input', me);
}

async function followParent() {
	if (!sameAsParent.value || !props.parentField || !props.parentCollection || !props.parentOwnerField) return;
	const parentId = idOf(values.value?.[props.parentField]);
	if (!parentId) return;
	const res = await api.get(`/items/${props.parentCollection}/${parentId}`, { params: { fields: [props.parentOwnerField] } });
	const owner = idOf(res?.data?.data?.[props.parentOwnerField]);
	if (owner) {
		await ensureListed(owner);
		emit('input', owner);
	}
}

const parentValue = computed(() => (props.parentField ? idOf(values.value?.[props.parentField]) : null));
watch([sameAsParent, parentValue], () => { followParent(); });
watch(() => props.value, (v) => { ensureListed(v); });

onMounted(async () => {
	try {
		await loadResearchers();
		await ensureListed(props.value);
		await prefillMe();
	} catch { /* network failure: plain dropdown still usable */ }
});
</script>

<style scoped>
.d1-owner-picker { width: 100%; }
.same { margin-top: 8px; }
</style>
```

- [ ] **Step 4: Build the interface**

Run: `cd core/extensions/d1-owner-picker && npm install && npm run build && cd -`
Expected: `dist/index.js` created, build ends without errors.

- [ ] **Step 5: Write the metadata migration**

`db/migrations/20261001000126_owner_picker_fields.sql`:
```sql
-- migrate:up
UPDATE directus_fields f
   SET interface = 'd1-owner-picker', options = v.opts::json, display = 'related-values',
       display_options = '{"template":"{{full_name}}"}'
  FROM (VALUES
    ('physical_samples',         'owner_person_id',               '{}'),
    ('tool_boxes',               'owner_person_id',               '{}'),
    ('cutting_inserts',          'owner_person_id',               '{"parentField":"tool_box_id","parentCollection":"tool_boxes","parentOwnerField":"owner_person_id"}'),
    ('insert_edges',             'owner_person_id',               '{"parentField":"insert_id","parentCollection":"cutting_inserts","parentOwnerField":"owner_person_id"}'),
    ('etchants',                 'owner_person_id',               '{}'),
    ('prep_recipes',             'owner_person_id',               '{}'),
    ('campaigns',                'owner_person_id',               '{"parentField":"project_id","parentCollection":"projects","parentOwnerField":"principal_investigator_person"}'),
    ('manufacturing_operations', 'owner_person_id',               '{"parentField":"campaign_id","parentCollection":"campaigns","parentOwnerField":"owner_person_id"}'),
    ('test_sessions',            'owner_person_id',               '{"parentField":"campaign_id","parentCollection":"campaigns","parentOwnerField":"owner_person_id"}'),
    ('projects',                 'principal_investigator_person', '{}')
  ) v(collection, field, opts)
 WHERE f.collection = v.collection AND f.field = v.field;

-- migrate:down
UPDATE directus_fields
   SET interface = 'select-dropdown-m2o', options = '{"template":"{{full_name}}","enableCreate":true}'::json
 WHERE interface = 'd1-owner-picker';
```

- [ ] **Step 6: Apply, reload, and run the metadata test**

Run the dbmate `up` command, the Directus reload command, then `node --test tests/ownership/owner-picker-meta.test.mjs`.
Expected: 10 passing.

- [ ] **Step 7: Write and run the UI test**

`tests/ui/specs/10-owner-picker.spec.ts`:
```ts
import { test, expect } from '../fixtures';
import { gotoCreateForm, fieldByLabel } from '../helpers';

// The UI suite logs in as admin@example.com, whose person is "Admin User" (a researcher).
test('new sample: owner is prefilled with the logged-in researcher', async ({ page }) => {
	await gotoCreateForm(page, 'physical_samples');
	await expect(fieldByLabel(page, 'Owner')).toContainText('Admin User', { timeout: 10_000 });
});

test('new cutting insert: "Same as parent" is offered', async ({ page }) => {
	await gotoCreateForm(page, 'cutting_inserts');
	await expect(fieldByLabel(page, 'Owner').getByText('Same as parent')).toBeVisible();
});
```
Run: `cd tests/ui && npx playwright test specs/10-owner-picker.spec.ts && cd -`
Expected: 2 passed.

- [ ] **Step 8: Manual check of "same as parent" (browser)**

In the Directus app as admin: create a cutting insert, pick a tool box whose owner is someone else, tick **Same as parent** → the owner switches to the box's owner and the dropdown locks; untick → it stays editable. Open an existing sample owned by a technician → its owner shows `<name> (not a researcher)` and is not cleared.

- [ ] **Step 9: Mirror and commit**

In `scripts/configure_directus.sql` (and `scripts/configure_campaigns.sql`, `scripts/configure_sample_prep.sql` for campaigns/etchants/prep_recipes), no `owner_person_id` rows exist (they come from migration 062), so no mirror edit is needed; leave a note in the migration header only.

```bash
git add core/extensions/d1-owner-picker/package.json core/extensions/d1-owner-picker/package-lock.json core/extensions/d1-owner-picker/src db/migrations/20261001000126_owner_picker_fields.sql tests/ui/specs/10-owner-picker.spec.ts tests/ownership/owner-picker-meta.test.mjs
git commit -m "feat(directus): d1-owner-picker — researcher-only owner, prefilled, with same-as-parent"
```

---

### Task 9: Remove the legacy ownership fields

**Depends on:** Tasks 3 and 4 applied.

**Files:**
- Create: `db/migrations/20261001000127_drop_legacy_ownership.sql`
- Delete: `core/extensions/owner-cascade/` (whole directory)
- Modify: `scripts/fast_mapping.py` (add `person_maps`)
- Modify: `scripts/import_fast_logs.py`, `scripts/import_fast25.py`, `scripts/import_fast250.py`, `scripts/import_experiment_sheet.py`, `scripts/import_milling_jozef.py`, `scripts/transfer_sample_ownership.py`
- Modify: `scripts/configure_directus.sql`, `scripts/configure_campaigns.sql`, `scripts/configure_sample_prep.sql`
- Create: `tests/ownership/legacy-removed.test.mjs`

**Interfaces:**
- Consumes: person fields fully populated (Tasks 3–4); `expand_tool_box_intake` no longer referencing `owner` (Task 7).
- Produces: `fast_mapping.person_maps(cur) -> (user_to_person: dict, name_to_person: dict)`.

- [ ] **Step 1: Write the failing test**

`tests/ownership/legacy-removed.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, sqlOne } from './lib.mjs';

test('legacy columns are gone', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND (
		column_name IN ('owner', 'cascade_ownership', 'principal_investigator_name')
		OR (column_name = 'operator' AND table_name IN ('manufacturing_operations', 'test_sessions'))
		OR (column_name = 'principal_investigator' AND table_name = 'projects')
		OR (column_name = 'user_id' AND table_name IN ('project_investigators', 'sample_co_owners')))`), '0');
});

test('no Directus field metadata points at dropped columns', () => {
	assert.equal(sqlOne(`SELECT count(*) FROM directus_fields WHERE
		(field IN ('owner', 'cascade_ownership', 'principal_investigator_name'))
		OR (field = 'operator' AND collection IN ('manufacturing_operations', 'test_sessions'))
		OR (field = 'principal_investigator' AND collection = 'projects')
		OR (field = 'user_id' AND collection IN ('project_investigators', 'sample_co_owners'))`), '0');
});

test('junctions are keyed on person_id', () => {
	assert.equal(sqlOne(`SELECT junction_field FROM directus_relations WHERE many_collection = 'project_investigators' AND many_field = 'project_id'`), 'person_id');
	assert.equal(sqlOne(`SELECT one_collection FROM directus_relations WHERE many_collection = 'sample_co_owners' AND many_field = 'person_id'`), 'people');
});

test('project rollup view still works', () => {
	assert.ok(Number(sqlOne(`SELECT count(*) FROM v_project_rollup`)) > 0);
});

test('projects and samples still load with their investigators / co-owners', async () => {
	const admin = await adminToken();
	const p = await api('GET', '/items/projects?limit=3&fields=*,secondary_investigators.person_id.full_name', admin);
	assert.equal(p.status, 200, JSON.stringify(p.data));
	const s = await api('GET', '/items/physical_samples?limit=3&fields=*,co_owners.person_id.full_name', admin);
	assert.equal(s.status, 200, JSON.stringify(s.data));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/ownership/legacy-removed.test.mjs`
Expected: FAIL — legacy columns still present.

- [ ] **Step 3: Write the migration**

`db/migrations/20261001000127_drop_legacy_ownership.sql`:
```sql
-- migrate:up
-- Final step of the ownership cleanup: drop the login-based owner / operator /
-- PI columns and the cascade toggle, and key the investigator / co-owner
-- junctions on people. Aborts if any legacy value lacks its person field.
DO $$
DECLARE t text; n bigint;
BEGIN
    FOREACH t IN ARRAY ARRAY['tool_boxes','cutting_inserts','insert_edges','physical_samples',
                             'manufacturing_operations','test_sessions','campaigns','etchants','prep_recipes'] LOOP
        EXECUTE format('SELECT count(*) FROM %I WHERE owner IS NOT NULL AND owner_person_id IS NULL', t) INTO n;
        IF n > 0 THEN RAISE EXCEPTION 'drop legacy: % rows of % still depend on the legacy owner', n, t; END IF;
    END LOOP;
    SELECT count(*) INTO n FROM projects WHERE principal_investigator IS NOT NULL AND principal_investigator_person IS NULL;
    IF n > 0 THEN RAISE EXCEPTION 'drop legacy: % projects still depend on the legacy PI', n; END IF;
    SELECT count(*) INTO n FROM manufacturing_operations WHERE operator IS NOT NULL AND nullif(trim(operator_name), '') IS NULL;
    IF n > 0 THEN RAISE EXCEPTION 'drop legacy: % operations would lose their operator text', n; END IF;
END $$;

-- v_project_rollup selected o.*; list only the columns it uses so the drops succeed.
CREATE OR REPLACE VIEW v_project_rollup AS
WITH ops AS (
    SELECT o.operation_id, o.pass_code, o.machining_operation_subtype, o.campaign_id,
           o.tool_id, o.insert_edge_id, o.sample_id, o.material_id, o.equipment_id,
           COALESCE(o.project_id, c.project_id) AS proj
    FROM manufacturing_operations o
    LEFT JOIN campaigns c ON c.campaign_id = o.campaign_id
    WHERE COALESCE(o.project_id, c.project_id) IS NOT NULL
)
SELECT md5('operation:' || operation_id::text) AS row_id, proj AS project_id,
       'operation'::text AS kind, pass_code AS code,
       machining_operation_subtype AS detail, campaign_id
FROM ops
UNION ALL
SELECT DISTINCT md5('tool:' || proj::text || ':' || t.tool_id::text), proj,
       'tool', t.tool_code, t.tool_name, NULL::uuid
FROM ops JOIN tools t ON t.tool_id = ops.tool_id
UNION ALL
SELECT DISTINCT md5('edge:' || proj::text || ':' || e.edge_id::text), proj,
       'insert_edge', e.edge_code, NULL, NULL::uuid
FROM ops JOIN insert_edges e ON e.edge_id = ops.insert_edge_id
UNION ALL
SELECT DISTINCT md5('insert:' || proj::text || ':' || ci.insert_id::text), proj,
       'cutting_insert', ci.insert_code, NULL, NULL::uuid
FROM ops JOIN insert_edges e ON e.edge_id = ops.insert_edge_id
         JOIN cutting_inserts ci ON ci.insert_id = e.insert_id
UNION ALL
SELECT DISTINCT md5('sample:' || proj::text || ':' || s.sample_id::text), proj,
       'sample', s.sample_code, s.nickname, NULL::uuid
FROM ops JOIN physical_samples s ON s.sample_id = ops.sample_id
UNION ALL
SELECT DISTINCT md5('material:' || proj::text || ':' || m.material_id::text), proj,
       'material', m.alloy_code, m.common_name, NULL::uuid
FROM ops JOIN materials m ON m.material_id = ops.material_id
UNION ALL
SELECT DISTINCT md5('equipment:' || proj::text || ':' || eq.equipment_id::text), proj,
       'equipment', eq.equipment_code, eq.equipment_name, NULL::uuid
FROM ops JOIN equipment eq ON eq.equipment_id = ops.equipment_id;

-- Junctions: person_id becomes the key.
DELETE FROM project_investigators d USING project_investigators k
 WHERE d.project_id = k.project_id AND d.person_id = k.person_id AND d.id > k.id;
ALTER TABLE project_investigators ALTER COLUMN person_id SET NOT NULL;
ALTER TABLE project_investigators DROP CONSTRAINT project_investigators_unique;
ALTER TABLE project_investigators ADD CONSTRAINT project_investigators_unique UNIQUE (project_id, person_id);
ALTER TABLE project_investigators DROP COLUMN user_id;

DELETE FROM sample_co_owners d USING sample_co_owners k
 WHERE d.sample_id = k.sample_id AND d.person_id = k.person_id AND d.id > k.id;
ALTER TABLE sample_co_owners ALTER COLUMN person_id SET NOT NULL;
ALTER TABLE sample_co_owners DROP CONSTRAINT sample_co_owners_unique;
ALTER TABLE sample_co_owners ADD CONSTRAINT sample_co_owners_unique UNIQUE (sample_id, person_id);
ALTER TABLE sample_co_owners DROP COLUMN user_id;

UPDATE directus_relations SET junction_field = 'person_id'
 WHERE many_collection IN ('project_investigators', 'sample_co_owners') AND junction_field = 'user_id';
DELETE FROM directus_relations
 WHERE many_collection IN ('project_investigators', 'sample_co_owners') AND many_field = 'user_id';
INSERT INTO directus_relations (many_collection, many_field, one_collection, junction_field, one_deselect_action)
SELECT v.mc, 'person_id', 'people', v.jf, 'nullify'
FROM (VALUES ('project_investigators', 'project_id'), ('sample_co_owners', 'sample_id')) v(mc, jf)
WHERE NOT EXISTS (SELECT 1 FROM directus_relations r WHERE r.many_collection = v.mc AND r.many_field = 'person_id');
DELETE FROM directus_fields WHERE collection IN ('project_investigators', 'sample_co_owners') AND field = 'user_id';
UPDATE directus_fields SET special = 'm2o', interface = 'select-dropdown-m2o',
       options = '{"template":"{{full_name}}"}', hidden = false, readonly = false, note = NULL
 WHERE collection IN ('project_investigators', 'sample_co_owners') AND field = 'person_id';
UPDATE directus_fields SET options = '{"template":"{{person_id.full_name}}","junction_field":"person_id"}'
 WHERE (collection, field) IN (('projects', 'secondary_investigators'), ('physical_samples', 'co_owners'));

-- Drop the legacy columns and their metadata.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tool_boxes','cutting_inserts','insert_edges','physical_samples',
                             'manufacturing_operations','test_sessions','campaigns','etchants','prep_recipes'] LOOP
        EXECUTE format('ALTER TABLE %I DROP COLUMN owner', t);
    END LOOP;
END $$;
ALTER TABLE manufacturing_operations DROP COLUMN operator;
ALTER TABLE test_sessions DROP COLUMN operator;
ALTER TABLE projects DROP COLUMN principal_investigator, DROP COLUMN principal_investigator_name;
ALTER TABLE tool_boxes DROP COLUMN cascade_ownership;
ALTER TABLE cutting_inserts DROP COLUMN cascade_ownership;

DELETE FROM directus_relations
 WHERE many_field IN ('owner', 'principal_investigator')
    OR (many_field = 'operator' AND many_collection IN ('manufacturing_operations', 'test_sessions'));
DELETE FROM directus_fields
 WHERE field IN ('owner', 'cascade_ownership', 'principal_investigator_name')
    OR (field = 'operator' AND collection IN ('manufacturing_operations', 'test_sessions'))
    OR (field = 'principal_investigator' AND collection = 'projects');

DROP TABLE login_aliases;

-- migrate:down
-- Structural rollback only; the dropped values are not restored.
CREATE TABLE IF NOT EXISTS login_aliases (
    alias_user_id     uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
    canonical_user_id uuid NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE
);
ALTER TABLE tool_boxes ADD COLUMN cascade_ownership boolean NOT NULL DEFAULT false;
ALTER TABLE cutting_inserts ADD COLUMN cascade_ownership boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN principal_investigator uuid REFERENCES directus_users(id) ON DELETE SET NULL,
                     ADD COLUMN principal_investigator_name text;
ALTER TABLE manufacturing_operations ADD COLUMN operator integer REFERENCES "Machine_Operators"(id);
ALTER TABLE test_sessions ADD COLUMN operator integer REFERENCES "Machine_Operators"(id);
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tool_boxes','cutting_inserts','insert_edges','physical_samples',
                             'manufacturing_operations','test_sessions','campaigns','etchants','prep_recipes'] LOOP
        EXECUTE format('ALTER TABLE %I ADD COLUMN owner uuid', t);
    END LOOP;
END $$;
ALTER TABLE project_investigators ADD COLUMN user_id uuid;
ALTER TABLE project_investigators ALTER COLUMN person_id DROP NOT NULL;
ALTER TABLE sample_co_owners ADD COLUMN user_id uuid;
ALTER TABLE sample_co_owners ALTER COLUMN person_id DROP NOT NULL;
```

- [ ] **Step 4: Update the import scripts before applying**

In `scripts/fast_mapping.py`, add after `user_name_index`:
```python
def person_maps(cur):
    """Return (user_to_person, name_to_person) for writing *_person_id columns.

    user_to_person maps a directus_users id to its people row; name_to_person
    maps a lower-cased full name to a person (operators are matched by exact
    name only; unmatched operators keep just their operator_name text).
    """
    cur.execute("SELECT user_id, person_id FROM people WHERE user_id IS NOT NULL")
    user_to_person = {u: p for u, p in cur.fetchall()}
    cur.execute("SELECT lower(full_name), person_id FROM people")
    name_to_person = {n: p for n, p in cur.fetchall()}
    return user_to_person, name_to_person
```

In `scripts/import_fast_logs.py`, `scripts/import_fast25.py` and `scripts/import_fast250.py`:
- Delete the block that selects from and inserts into `"Machine_Operators"` (the `op_to_id` dict and its loop).
- After the `email_to_user` lookup add: `user_to_person, name_to_person = fm.person_maps(cur)`.
- In `cols`, replace `"operator",` with `"operator_person_id",` and `"owner",` with `"owner_person_id",`.
- In the values tuple, replace `op_to_id.get(<x>["operator_disp"]),` with `name_to_person.get((<x>["operator_disp"] or "").lower()),` (where `<x>` is `b` in `import_fast_logs.py` and `o` in the other two).
- Replace the owner value: in `import_fast_logs.py` `email_to_user.get(b["owner_email"]) if b["owner_email"] else None,` → `user_to_person.get(email_to_user.get(b["owner_email"])) if b["owner_email"] else None,`; in `import_fast25.py`/`import_fast250.py` `resolve_owner(o),` → `user_to_person.get(resolve_owner(o)),`.

In `scripts/import_experiment_sheet.py`:
- `"SELECT project_id, owner FROM campaigns WHERE campaign_id = %s"` → `"SELECT project_id, owner_person_id FROM campaigns WHERE campaign_id = %s"`.
- In `cols`, `"owner",` → `"owner_person_id",` (the value `owner` from the campaign row is now a person id; no other change).

In `scripts/import_milling_jozef.py`, in the INSERT column list remove `owner, ` and in `VALUES` remove one `%s`, and remove `JOZEF_USER,` from the parameter list:
```python
            INSERT INTO manufacturing_operations
                (operation_id, method_id, process_category, machining_operation_subtype,
                 sample_id, owner_person_id, operator_name, campaign_id,
                 operation_date, pass_code, force_file_id)
            VALUES (%s, %s, 'machining', NULL, %s, %s, 'Jozef McGowan', %s, %s, %s, %s)
            ON CONFLICT (operation_id) DO NOTHING
```
with parameters `[op_id, MM_METHOD_ID, sample_id, JOZEF_PERSON, CAMPAIGN_ID, op_date, stem, stem]`. Delete the `JOZEF_USER = ...` constant if nothing else uses it (`grep -n JOZEF_USER scripts/import_milling_jozef.py`).

In `scripts/transfer_sample_ownership.py`:
- Module docstring: `physical_samples.owner` → `physical_samples.owner_person_id` (both occurrences), and the sentence about ADR-0002 → `Owners are resolved to that login's people row; logins without one are reported as unresolved.`
- Replace `cur.execute("SELECT id::text FROM directus_users")` / `existing = {...}` with:
  ```python
  cur.execute("SELECT user_id::text, person_id::text FROM people WHERE user_id IS NOT NULL")
  user_to_person = {u: p for u, p in cur.fetchall()}
  ```
- In the loop, replace `if uid and uid in existing:` / the UPDATE with:
  ```python
  person = user_to_person.get(uid) if uid else None
  if person:
      cur.execute(
          "UPDATE physical_samples SET owner_person_id=%s WHERE sample_code=%s",
          (person, code),
      )
  ```

Check nothing else writes the dropped columns:
```bash
grep -rnE "\b(owner|operator|principal_investigator|principal_investigator_name|cascade_ownership)\b\s*[,=)]" scripts/*.py | grep -v "_person\|operator_name\|owner_email\|owner_from\|resolve_owner"
```
Expected: no output (fix any hit the same way).

- [ ] **Step 5: Remove the cascade hook and mirror the metadata files**

```bash
git rm -r core/extensions/owner-cascade
```
In `scripts/configure_directus.sql`, `scripts/configure_campaigns.sql` and `scripts/configure_sample_prep.sql`, delete every `directus_fields` VALUES row whose field is `'owner'`, `'cascade_ownership'`, `'principal_investigator_name'`, `('projects','principal_investigator'`, or `'operator'` on `manufacturing_operations`/`test_sessions`, and every `directus_relations` row with those many-fields. In `configure_directus.sql` also change the `project_investigators`/`sample_co_owners` `user_id` rows to `person_id` with template `{{full_name}}`, and the `secondary_investigators`/`co_owners` options to `{"template":"{{person_id.full_name}}","junction_field":"person_id"}`. Verify:
```bash
grep -nE "'(owner|cascade_ownership|principal_investigator_name)'" scripts/configure_directus.sql scripts/configure_campaigns.sql scripts/configure_sample_prep.sql
```
Expected: no output.

- [ ] **Step 6: Back up again, apply, reload, and run the whole suite**

This migration drops columns. Run `bash infra/backup/backup.sh` first and note the file. Then run the dbmate `up` command, the Directus reload command, then:
```bash
node --test tests/ownership/
py -3 -m py_compile scripts/fast_mapping.py scripts/import_fast_logs.py scripts/import_fast25.py scripts/import_fast250.py scripts/import_experiment_sheet.py scripts/import_milling_jozef.py scripts/transfer_sample_ownership.py
```
Expected: every ownership test passes (the legacy-column assertions in `identity.test.mjs` / `backfill.test.mjs` now reference dropped columns — delete those specific tests in this step: `no legacy login FK still points at an alias login` in `identity.test.mjs`, and every test in `backfill.test.mjs` except `James Pepper's historical operations…`, since their subject no longer exists); `py_compile` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add db/migrations/20261001000127_drop_legacy_ownership.sql tests/ownership scripts/fast_mapping.py scripts/import_fast_logs.py scripts/import_fast25.py scripts/import_fast250.py scripts/import_experiment_sheet.py scripts/import_milling_jozef.py scripts/transfer_sample_ownership.py scripts/configure_directus.sql scripts/configure_campaigns.sql scripts/configure_sample_prep.sql
git commit -m "feat(db): drop legacy login-based owner/operator/PI fields; junctions keyed on people"
```

---

### Task 10: Dashboard for additional operators, force-app compatibility, schema dump

**Files:**
- Modify: `packages/force-plotting/src/ForceDashboard.vue:959-964` (scoping filter)
- Create: `tests/ownership/force-app.test.mjs`
- Modify: `db/schema.sql` (regenerated)

**Interfaces:**
- Consumes: `additional_operators` M2M on `manufacturing_operations` (Task 3A).

- [ ] **Step 1: Write the force-app compatibility test**

`tests/ownership/force-app.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminToken, api, createUser, deleteUser, personOf, sqlOne } from './lib.mjs';

// Mirrors packages/force-plotting/src/ForceDashboard.vue: find "my" person via
// people.user_id, then analyses whose sample owner / op owner / op operator is me.
test("a researcher's force dashboard scoping finds their own operation", async () => {
	const admin = await adminToken();
	const u = await createUser(admin, 'Dash');
	const methodId = sqlOne(`SELECT method_id FROM manufacturing_methods WHERE method_code = 'MT'`);
	let opId, faId;
	try {
		const op = await api('POST', '/items/manufacturing_operations', u.token, {
			method_id: methodId, process_category: 'machining', capture_software: 'force-app', machining_force_captured: true,
		});
		assert.equal(op.status, 200, JSON.stringify(op.data));
		opId = op.data.data.operation_id;
		// directus_files_id is required; any existing file will do for a scoping check.
		const fileId = sqlOne(`SELECT id FROM directus_files LIMIT 1`);
		const fa = await api('POST', '/items/machining_force_analysis', u.token, { operation_id: opId, directus_files_id: fileId, status: 'done' });
		assert.equal(fa.status, 200, JSON.stringify(fa.data));
		faId = fa.data.data.id;

		const me = await api('GET', `/items/people?filter[user_id][_eq]=${u.userId}&limit=1&fields=person_id`, u.token);
		const myPerson = me.data.data[0].person_id;
		assert.equal(myPerson, personOf(u.userId));
		const list = await api('GET', `/items/machining_force_analysis?filter=${encodeURIComponent(JSON.stringify(dashboardFilter(myPerson)))}&fields=operation_id&limit=-1`, u.token);
		assert.equal(list.status, 200, JSON.stringify(list.data));
		assert.ok(list.data.data.some((r) => r.operation_id === opId));
	} finally {
		if (faId) await api('DELETE', `/items/machining_force_analysis/${faId}`, admin);
		if (opId) await api('DELETE', `/items/manufacturing_operations/${opId}`, admin);
		await deleteUser(admin, u.userId);
	}
});

test('an additional operator sees the run in their dashboard', async () => {
	const admin = await adminToken();
	const owner = await createUser(admin, 'DashOwner');
	const helper = await createUser(admin, 'DashHelper');
	const methodId = sqlOne(`SELECT method_id FROM manufacturing_methods WHERE method_code = 'MT'`);
	const fileId = sqlOne(`SELECT id FROM directus_files LIMIT 1`);
	let opId, faId;
	try {
		const op = await api('POST', '/items/manufacturing_operations', owner.token, {
			method_id: methodId, additional_operators: [{ person_id: personOf(helper.userId) }],
		});
		assert.equal(op.status, 200, JSON.stringify(op.data));
		opId = op.data.data.operation_id;
		const fa = await api('POST', '/items/machining_force_analysis', owner.token, { operation_id: opId, directus_files_id: fileId, status: 'done' });
		assert.equal(fa.status, 200, JSON.stringify(fa.data));
		faId = fa.data.data.id;
		const list = await api('GET', `/items/machining_force_analysis?filter=${encodeURIComponent(JSON.stringify(dashboardFilter(personOf(helper.userId))))}&fields=operation_id&limit=-1`, helper.token);
		assert.equal(list.status, 200, JSON.stringify(list.data));
		assert.ok(list.data.data.some((r) => r.operation_id === opId));
	} finally {
		if (faId) await api('DELETE', `/items/machining_force_analysis/${faId}`, admin);
		if (opId) await api('DELETE', `/items/manufacturing_operations/${opId}`, admin);
		await deleteUser(admin, owner.userId);
		await deleteUser(admin, helper.userId);
	}
});

// Must stay identical to the filter in packages/force-plotting/src/ForceDashboard.vue.
function dashboardFilter(personId) {
	return { _and: [{ status: { _eq: 'done' } }, { _or: [
		{ 'operation_id.sample_id.owner_person_id': { _eq: personId } },
		{ 'operation_id.owner_person_id': { _eq: personId } },
		{ 'operation_id.operator_person_id': { _eq: personId } },
		{ 'operation_id.additional_operators.person_id': { _eq: personId } },
	] }] };
}
```

- [ ] **Step 2: Run it to verify the additional-operator test fails**

Run: `node --test tests/ownership/force-app.test.mjs`
Expected: the first test passes; `an additional operator sees the run in their dashboard` passes too at the API level (the test's own filter includes the new condition). This step only proves the filter is valid Directus; the dashboard itself changes in Step 3.

- [ ] **Step 3: Add the condition to the dashboard filter**

In `packages/force-plotting/src/ForceDashboard.vue`, replace:
```js
			// Related to me = I own the sample, own the operation, or ran it.
			filter._and = [{ _or: [
				{ 'operation_id.sample_id.owner_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.owner_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.operator_person_id': { _eq: myPersonId.value } },
			] }];
```
with:
```js
			// Related to me = I own the sample, own the operation, or ran it
			// (as its main operator or as one of its additional operators).
			filter._and = [{ _or: [
				{ 'operation_id.sample_id.owner_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.owner_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.operator_person_id': { _eq: myPersonId.value } },
				{ 'operation_id.additional_operators.person_id': { _eq: myPersonId.value } },
			] }];
```
Then type-check, test, and rebuild the Directus dashboard extension that bundles this package:
```bash
cd packages/force-plotting && npx vue-tsc --noEmit && npx vitest run && cd -
npm run build:extension
```
Reload Directus (Global Constraints). The desktop force app picks the change up in its next release (no `apps/force-app` edit).

- [ ] **Step 4: Run the full suite**

```bash
node --test tests/ownership/
py -3 -m pytest tests/scripts/test_operator_mapping_to_sql.py -q
cd tests/ui && npx playwright test specs/09-campaign-inheritance.spec.ts specs/10-owner-picker.spec.ts && cd -
```
Expected: all pass.

- [ ] **Step 5: Confirm the force app itself is untouched**

```bash
git diff main --stat -- apps/force-app
```
Expected: no output.

- [ ] **Step 6: Regenerate schema.sql**

```bash
DBURL=$(grep ^DATABASE_URL= .env | cut -d= -f2- | sed 's/@localhost:/@postgres:/')
docker run --rm -e DATABASE_URL="$DBURL" --network d1-database_d1net -v "//d/Users/CMBE Admn 3214022001/Documents/GitHub/D1-Database/db:/db" ghcr.io/amacneil/dbmate:2 dump
```
Expected: `Writing: ./db/schema.sql`; `git diff --stat db/schema.sql` shows the new tables/columns/functions and the dropped columns.

- [ ] **Step 7: Commit**

```bash
git add packages/force-plotting/src/ForceDashboard.vue tests/ownership/force-app.test.mjs db/schema.sql
git commit -m "feat(force-plotting): additional operators see their runs; ownership compatibility tests; regenerate schema"
```
