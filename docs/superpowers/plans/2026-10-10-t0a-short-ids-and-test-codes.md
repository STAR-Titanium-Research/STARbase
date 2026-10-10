# T0a: short IDs and test codes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give samples, operations and tests a permanent short ID, and give every test a readable
code built from its subject and type, assigned and kept up to date by the database.

**Architecture:** Three dbmate migrations (150-152). Short IDs: a registry table `short_ids` that
makes them unique across the three tables, a claim function and one generic trigger. Test codes:
columns on `test_sessions`, a counter table so numbers are never reused, a BEFORE trigger that
builds the code from the earliest-linked subject, and AFTER triggers on samples and edges so a
corrected subject code flows into its tests. Everything is checked in `tests/phase1_schema.sh`.

**Tech Stack:** PostgreSQL 16 (pgvector image), PL/pgSQL, dbmate (`-- migrate:up` / `-- migrate:down`),
Directus 11 metadata tables (`directus_fields`), bash test harness, Docker.

**Spec:** [`docs/superpowers/specs/2026-10-10-record-codes-design.md`](../specs/2026-10-10-record-codes-design.md)
(approved 2026-10-10), sections 1 and 2, and §4 for tests. This is stage **T0a** of six; T0b-T0f
get their own plans after this one lands.

## Global Constraints

- Work in the worktree `.claude/worktrees/t0-record-codes` on branch `feat/record-codes` (Task 1
  creates it). Never touch the main checkout, never apply anything to the live database, never run
  `scripts/configure_all.sh` or `scripts/configure_directus.sql`.
- Migration versions: `20261010000150`, `20261010000151`, `20261010000152` (the latest anywhere is
  `20261009000143`).
- Every new table, column, function and trigger carries a `COMMENT` (text-to-SQL depends on them).
- Every `migrate:down` undoes its `migrate:up` exactly, in reverse order.
- Trigger functions use `LANGUAGE plpgsql` and `SET search_path = pg_catalog, public`, as
  `20261003000126` / `20261003000127` do.
- Directus metadata written by a migration (`INSERT INTO directus_fields`) is inserted only where
  missing (`WHERE NOT EXISTS (collection, field)`) and is checked by a test on CI's stub tables.
- Test codes: `{subject code}-{ABBR}{n}`; ABBR: tensile TEN, hardness HRD, charpy CHP, compression
  CMP, tribology TRB, optical_microscopy OM, sem SEM, tem TEM, xrd XRD, alicona ALI, clemx CLX,
  dct DCT, ct_scan CT, fatigue FAT, creep CRP, dma DMA, other OTH.
- Short ID = `left(replace(<uuid>::text, '-', ''), 8)`, lengthened one character at a time on a
  clash, unique across samples, operations and tests, never changed.
- Commit after each task with a Conventional Commit message ending in
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests are run, not left to CI: `scripts/dev/schema_test_docker.sh` (Task 1) before every commit.

## Decisions this plan makes where the spec was silent (flagged for the reviewer)

1. **The code's subject is the earliest-linked subject across samples and edges together**
   (`ORDER BY linked_at, id` over both collections). `test_sessions.sample_id` and
   `insert_edge_id` are two separate primaries, so "sample if set, else edge" would rename an edge
   test when a sample is added, against Q25.
2. **The type the number was drawn for is stored** (`test_code_type`), so a new number is drawn
   when the type changes even if the code was typed by hand in between.
3. **No advisory lock for short IDs** (the spec said one shared lock). A short-ID trigger on
   `manufacturing_operations` that took a global lock before the statement-level
   `refresh_rollup_ops` (rollup lock) would invert the lock order against an insert that takes the
   rollup lock first in `mfg_op_assign_numbers`. The registry's PRIMARY KEY settles races instead
   (`INSERT … ON CONFLICT DO NOTHING`, then try one character longer).
4. **Registry rows are kept when a record is deleted** (the spec said removed). A deleted sample's
   label must not start resolving to a new record; `record_by_short_id()` returns nothing for a
   deleted record.
5. **`test_code` uses the default collation, not `natural_sort`.** The natural-sort test replays
   migration 116's down, which drops the collation; a new column on it would break that replay.
   Sorting by number uses `test_code_number`.
6. **Back-fill runs with the tables' user triggers disabled** so 10,445 rows do not each bump
   `version`, write an audit row and refresh the rollup. The migration first checks that no user
   trigger on those tables is already disabled, so `ENABLE TRIGGER USER` restores exactly.

## Review Focus

- A client that re-sends the whole record, `test_code` included and unchanged, must not turn an
  automatic code into a typed one. → Task 4 test `resave`.
- A typed code that is already some other test's automatic code, or the reverse, must give a clear
  UNIQUE error for the typed one and make the automatic one skip to the next number. → Task 4 tests
  `skip_taken` and `unique`.
- Deleting the sample a test's code is built on must re-code the test from its next subject, or
  keep the code when none is left. → Task 4 tests `promoted` and `orphan`.
- Junction items written in upper case or as junk must not break code building (the sync already
  tolerates them). → Task 4 test `junk_subject`.
- A test with no type yet, or a subject without a code, must stay codeless without an error, then
  get its code when the type arrives. → Task 4 tests `notype` and `type_arrives`.

---

### Task 1: Worktree, merged base and the local schema-test harness

**Files:**
- Create: `scripts/dev/schema_test_docker.sh`
- Create: `scripts/dev/schema-runner.Dockerfile`

**Interfaces:**
- Produces: `bash scripts/dev/schema_test_docker.sh` (env `ROUNDTRIP=<n>` optional) — prints
  dbmate output, then the `tests/phase1_schema.sh` output ending `Results: N passed, M failed`.
  Every later task runs it.

- [ ] **Step 1: Create the worktree with the form-fix branch merged in**

From the main checkout (`D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database`):

```bash
git worktree add -b feat/record-codes .claude/worktrees/t0-record-codes feat/explorer-restyle
cd .claude/worktrees/t0-record-codes
git merge --no-edit fix/restore-inline-param-meta
git log --oneline -3
```

Expected: a merge commit on top; `db/migrations/20261009000143_restore_inline_param_field_meta.sql`
exists in the worktree. If the merge conflicts, stop and report (it should not: the branches touch
different files except `tests/phase1_schema.sh`, which `feat/explorer-restyle` did not change).

- [ ] **Step 2: Write the runner image**

`scripts/dev/schema-runner.Dockerfile`:

```dockerfile
# psql + bash + python3 for tests/phase1_schema.sh (the migration-141 block needs python3).
# Used by scripts/dev/schema_test_docker.sh; the same Postgres major as CI's service.
FROM pgvector/pgvector:pg16
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 3: Write the harness**

`scripts/dev/schema_test_docker.sh`:

```bash
#!/usr/bin/env bash
# Local stand-in for CI's "migrations" job, for machines without a host psql (Windows):
# a throwaway pgvector Postgres on an internal Docker network, dbmate up, the reference seed,
# then tests/phase1_schema.sh in a runner image with psql + python3. Optional ROUNDTRIP=<n>:
# afterwards roll back the newest n migrations and apply them again.
#
# Workaround, local only: migration 20261001000123 (operator back-fill) fails on an empty
# database because its operator names are not in people. When that happens the script adds the
# names it reports to people and runs dbmate again. CI will need its own fix (tracked separately).
#
# Usage: bash scripts/dev/schema_test_docker.sh        (from the repository root)
set -uo pipefail
export MSYS_NO_PATHCONV=1
REPO="$(pwd -W 2>/dev/null || pwd)"
NET=d1-schema-test; PG=d1-schema-test-pg; RUNNER=d1-schema-runner:1
URL="postgres://d1:ci_secret@$PG:5432/d1_test?sslmode=disable"

docker image inspect "$RUNNER" >/dev/null 2>&1 \
  || docker build -q -t "$RUNNER" -f scripts/dev/schema-runner.Dockerfile scripts/dev >/dev/null
docker rm -f "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
docker network create --internal "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=d1 -e POSTGRES_PASSWORD=ci_secret \
  -e POSTGRES_DB=d1_test pgvector/pgvector:pg16 >/dev/null
for _ in $(seq 1 30); do docker exec "$PG" pg_isready -U d1 -d d1_test >/dev/null 2>&1 && break; sleep 1; done

dbmate() { docker run --rm --network "$NET" -e DATABASE_URL="$URL" -v "$REPO/db:/db" \
  ghcr.io/amacneil/dbmate:2 --no-dump-schema "$@" 2>&1; }

out=$(dbmate up); echo "$out" | tail -2
if grep -q 'operator mapping: names missing' <<<"$out"; then
  names=$(sed -n 's/.*names missing or ambiguous in people: \(.*\) (P0001).*/\1/p' <<<"$out" | tr -d '\r\n')
  sql=$(printf '%s' "$names" | awk -v RS=', ' '{gsub(/\x27/,"\x27\x27"); printf "INSERT INTO people (full_name) VALUES (\x27%s\x27);\n", $0}')
  docker exec -i "$PG" psql -U d1 -d d1_test -q <<<"$sql"
  echo "(workaround: added $(wc -l <<<"$sql") operator names to people for migration 123)"
  dbmate up | tail -2
fi
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo "$RUNNER" \
  psql "$URL" -X -q -v ON_ERROR_STOP=1 -f db/seeds/001_reference_data.sql 2>&1 | tail -3
docker run --rm --network "$NET" -v "$REPO:/repo" -w /repo -e DATABASE_URL="$URL" "$RUNNER" \
  bash tests/phase1_schema.sh 2>&1
if [[ -n "${ROUNDTRIP:-}" ]]; then
  echo "== roundtrip: rollback x $ROUNDTRIP, then up"
  for _ in $(seq 1 "$ROUNDTRIP"); do dbmate rollback | tail -1; done
  dbmate up | tail -3
fi
docker rm -f "$PG" >/dev/null; docker network rm "$NET" >/dev/null
```

- [ ] **Step 4: Record the baseline**

```bash
bash scripts/dev/schema_test_docker.sh > /tmp/t0a-baseline.txt 2>&1
tail -1 /tmp/t0a-baseline.txt
grep FAIL /tmp/t0a-baseline.txt
```

Expected (measured on `feat/explorer-restyle` before the merge: `379 passed, 4 failed`; the merge
adds migration 143's checks): the four pre-existing failures and nothing else —
`Directus relations for campaigns are registered (5)`, `every business table has an audit
trigger`, and the two Lab Member `access_rules.json` checks. Keep this file: every later task
compares its FAIL lines against it ("no new FAIL").

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/schema_test_docker.sh scripts/dev/schema-runner.Dockerfile
git commit -m "chore(dev): run the schema tests in Docker on machines without psql

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 150 — short IDs

**Files:**
- Create: `db/migrations/20261010000150_short_ids.sql`
- Modify: `tests/phase1_schema.sh` (new section after the "Test subject junction" section, i.e.
  after the `ps_check "comments:5" …` line)

**Interfaces:**
- Produces: table `short_ids(short_id TEXT PK, collection TEXT, record_id UUID, created_at)`;
  function `claim_short_id(p_collection TEXT, p_record_id UUID) RETURNS TEXT`; trigger function
  `trg_assign_short_id()` (argument: the primary-key column name); column `short_id TEXT NOT NULL
  UNIQUE` on `physical_samples`, `manufacturing_operations`, `test_sessions`; function
  `record_by_short_id(p_short_id TEXT) RETURNS TABLE(collection TEXT, record_id UUID)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/phase1_schema.sh` after `ps_check "comments:5" …`:

```bash
echo "== Short IDs: permanent, unique across samples, operations and tests (T0a) =="
# The three fixture ids share their first 8 hex characters, so the second and third must be
# lengthened. Everything is rolled back.
sid_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code)
VALUES ('c0000000-0000-4000-8000-000000000201', 'TEST-SID-001');
INSERT INTO manufacturing_operations (operation_id, sample_id)
VALUES ('c0000000-0000-4000-8000-000000000202', 'c0000000-0000-4000-8000-000000000201');
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-000000000203');
SELECT 'sample:' || short_id FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-000000000201';
SELECT 'operation:' || short_id FROM manufacturing_operations WHERE operation_id = 'c0000000-0000-4000-8000-000000000202';
SELECT 'test:' || short_id FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-000000000203';
SELECT 'lookup:' || collection || '/' || record_id FROM record_by_short_id('C00000000');
DO $$ BEGIN
  UPDATE physical_samples SET short_id = 'deadbeef' WHERE sample_id = 'c0000000-0000-4000-8000-000000000201';
  RAISE NOTICE 'guard:missing';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'guard:ok';
END $$;
SELECT 'samecode:' || short_id FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-000000000201';
UPDATE physical_samples SET nickname = 'renamed' WHERE sample_id = 'c0000000-0000-4000-8000-000000000201';
SELECT 'other_update:' || short_id FROM physical_samples WHERE sample_id = 'c0000000-0000-4000-8000-000000000201';
DELETE FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-000000000203';
SELECT 'deleted_lookup:' || count(*) FROM record_by_short_id('c000000000');
SELECT 'registry_kept:' || count(*) FROM short_ids WHERE short_id = 'c000000000';
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-000000000204');
SELECT 'no_reuse:' || short_id FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-000000000204';
SELECT 'not_null:' || count(*) FROM information_schema.columns
  WHERE column_name = 'short_id' AND is_nullable = 'NO'
    AND table_name IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
SELECT 'directus_rows:' || count(*) FROM directus_fields
  WHERE field = 'short_id' AND readonly
    AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
SELECT 'comments:' || count(*) FROM pg_description d JOIN pg_class c ON c.oid = d.objoid
  WHERE c.relname = 'short_ids' AND d.objsubid = 0;
ROLLBACK;
SQL
)
sid_check() { grep -q -- "$1" <<<"$sid_out" && ok "$2" || bad "$2 (psql output: $sid_out)"; }
sid_check "sample:c0000000$" "a new sample gets the first 8 hex characters of its id"
sid_check "operation:c00000000$" "an operation whose 8 characters are taken by a sample gets 9"
sid_check "test:c000000000$" "a test whose 8 and 9 characters are taken gets 10"
sid_check "lookup:manufacturing_operations/c0000000-0000-4000-8000-000000000202" "record_by_short_id finds the record (case-insensitive)"
sid_check "guard:ok" "changing a short_id is refused"
sid_check "other_update:c0000000$" "other updates keep the short_id"
sid_check "deleted_lookup:0" "a deleted record's short ID resolves to nothing"
sid_check "registry_kept:1" "a deleted record's short ID stays reserved"
sid_check "no_reuse:c0000000000$" "a reserved short ID is never handed out again"
sid_check "not_null:3" "short_id is NOT NULL on the three tables"
sid_check "directus_rows:3" "the three short_id fields are registered read-only in Directus"
sid_check "comments:1" "short_ids carries a table comment"
```

How the expected values come about: the hex of `c0000000-0000-4000-8000-000000000204` is
`c000000000004000…`; its 8-, 9- and 10-character prefixes are taken (the 10-character one by the
deleted test, whose registry row stays), so it gets the 11 characters `c0000000000`.
The guard reports through `RAISE NOTICE`, which psql prints on stderr as `NOTICE:  guard:ok`;
`$PSQL 2>&1` captures it and `grep -q` (not `-x`) matches it. If the operation insert is refused
for a missing column, copy the minimal operation insert used in the "Operation numbers and codes
are assigned server-side" section (around line 940) and keep the fixture ids.

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash scripts/dev/schema_test_docker.sh > /tmp/t0a-2.txt 2>&1; grep -E "Short IDs|short" /tmp/t0a-2.txt | head -20
```

Expected: the new section's checks FAIL (`column "short_id" does not exist` in the psql output).

- [ ] **Step 3: Write the migration**

`db/migrations/20261010000150_short_ids.sql`:

```sql
-- migrate:up
-- Short IDs (stream T0a, spec docs/superpowers/specs/2026-10-10-record-codes-design.md §1).
--
-- Why: codes (sample, operation, test) now follow their fields and can change, and a printed
-- label, a finder search or a note needs a handle that never changes. The records' UUIDs never
-- change but are 36 characters long. The short ID is the first 8 hex characters of the UUID,
-- lengthened one character at a time on a clash, unique across samples, operations and tests
-- together (one registry), and never changed or reused.
--
-- No advisory lock: a global lock taken in a BEFORE trigger on manufacturing_operations would
-- invert the lock order against mfg_op_assign_numbers (rollup lock first). The registry's
-- primary key settles races: INSERT ... ON CONFLICT DO NOTHING, and try a longer prefix.
-- Registry rows are kept when a record is deleted, so a deleted sample's label never resolves to
-- a different record.

CREATE TABLE short_ids (
    short_id   TEXT PRIMARY KEY CHECK (short_id ~ '^[0-9a-f]{8,32}$'),
    collection TEXT NOT NULL CHECK (collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions')),
    record_id  UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT short_ids_record_unique UNIQUE (collection, record_id)
);

COMMENT ON TABLE short_ids IS
    'Registry of permanent short IDs (first 8+ hex characters of the record UUID) for physical_samples, manufacturing_operations and test_sessions. Unique across the three tables; rows are never deleted, so an ID is never reused. Bookkeeping: written only by claim_short_id().';
COMMENT ON COLUMN short_ids.short_id IS 'The short ID: lower-case hex, 8 characters, more only after a clash.';
COMMENT ON COLUMN short_ids.collection IS 'Which table the record is in.';
COMMENT ON COLUMN short_ids.record_id IS 'The record''s primary key (sample_id, operation_id or session_id). The record may since have been deleted.';
COMMENT ON COLUMN short_ids.created_at IS 'When the short ID was assigned.';

CREATE FUNCTION claim_short_id(p_collection TEXT, p_record_id UUID)
    RETURNS TEXT
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_hex TEXT := replace(p_record_id::text, '-', '');
    v_len INTEGER := 8;
    v_got TEXT;
BEGIN
    SELECT s.short_id INTO v_got
    FROM public.short_ids s
    WHERE s.collection = p_collection AND s.record_id = p_record_id;
    IF v_got IS NOT NULL THEN
        RETURN v_got;
    END IF;
    LOOP
        INSERT INTO public.short_ids (short_id, collection, record_id)
        VALUES (left(v_hex, v_len), p_collection, p_record_id)
        ON CONFLICT (short_id) DO NOTHING
        RETURNING short_id INTO v_got;
        IF v_got IS NOT NULL THEN
            RETURN v_got;
        END IF;
        v_len := v_len + 1;
        IF v_len > 32 THEN
            RAISE EXCEPTION 'no free short ID for % %', p_collection, p_record_id;
        END IF;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION claim_short_id(TEXT, UUID) IS
    'Returns the record''s short ID, assigning it on first call: the shortest unused prefix (8+ hex characters) of the UUID, registered in short_ids.';

CREATE FUNCTION trg_assign_short_id()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- TG_ARGV[0] names the primary-key column; defaults are filled before BEFORE triggers.
        NEW.short_id := public.claim_short_id(TG_TABLE_NAME, (to_jsonb(NEW) ->> TG_ARGV[0])::uuid);
    ELSIF NEW.short_id IS DISTINCT FROM OLD.short_id THEN
        RAISE EXCEPTION 'short_id never changes (% %)', TG_TABLE_NAME, OLD.short_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_assign_short_id() IS
    'BEFORE INSERT / UPDATE OF short_id: assigns the short ID of a new record (argument: its primary-key column) and refuses any change to it.';

-- Columns first, nullable, so the back-fill can fill them.
ALTER TABLE physical_samples ADD COLUMN short_id TEXT;
ALTER TABLE manufacturing_operations ADD COLUMN short_id TEXT;
ALTER TABLE test_sessions ADD COLUMN short_id TEXT;

-- backfill:start
-- With the tables' user triggers off, so 10k rows do not each bump version, write an audit row
-- and refresh the rollup. Refuse to run if one is already disabled: ENABLE TRIGGER USER below
-- would otherwise switch it on.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger
               WHERE NOT tgisinternal AND tgenabled = 'D'
                 AND tgrelid IN ('physical_samples'::regclass, 'manufacturing_operations'::regclass,
                                 'test_sessions'::regclass)) THEN
        RAISE EXCEPTION 'a user trigger on physical_samples / manufacturing_operations / test_sessions is disabled; enable it or back-fill by hand';
    END IF;
END $$;
ALTER TABLE physical_samples DISABLE TRIGGER USER;
ALTER TABLE manufacturing_operations DISABLE TRIGGER USER;
ALTER TABLE test_sessions DISABLE TRIGGER USER;
UPDATE physical_samples SET short_id = claim_short_id('physical_samples', sample_id);
UPDATE manufacturing_operations SET short_id = claim_short_id('manufacturing_operations', operation_id);
UPDATE test_sessions SET short_id = claim_short_id('test_sessions', session_id);
ALTER TABLE physical_samples ENABLE TRIGGER USER;
ALTER TABLE manufacturing_operations ENABLE TRIGGER USER;
ALTER TABLE test_sessions ENABLE TRIGGER USER;
-- backfill:end

ALTER TABLE physical_samples ALTER COLUMN short_id SET NOT NULL,
    ADD CONSTRAINT physical_samples_short_id_unique UNIQUE (short_id);
ALTER TABLE manufacturing_operations ALTER COLUMN short_id SET NOT NULL,
    ADD CONSTRAINT manufacturing_operations_short_id_unique UNIQUE (short_id);
ALTER TABLE test_sessions ALTER COLUMN short_id SET NOT NULL,
    ADD CONSTRAINT test_sessions_short_id_unique UNIQUE (short_id);

COMMENT ON COLUMN physical_samples.short_id IS
    'Permanent short ID (8+ hex characters of sample_id), unique across samples, operations and tests. Never changes; printed on labels. Assigned by trigger.';
COMMENT ON COLUMN manufacturing_operations.short_id IS
    'Permanent short ID (8+ hex characters of operation_id), unique across samples, operations and tests. Never changes. Assigned by trigger.';
COMMENT ON COLUMN test_sessions.short_id IS
    'Permanent short ID (8+ hex characters of session_id), unique across samples, operations and tests. Never changes. Assigned by trigger.';

CREATE TRIGGER physical_samples_short_id
    BEFORE INSERT OR UPDATE OF short_id ON physical_samples
    FOR EACH ROW EXECUTE FUNCTION trg_assign_short_id('sample_id');
CREATE TRIGGER mfg_op_short_id
    BEFORE INSERT OR UPDATE OF short_id ON manufacturing_operations
    FOR EACH ROW EXECUTE FUNCTION trg_assign_short_id('operation_id');
CREATE TRIGGER test_sessions_short_id
    BEFORE INSERT OR UPDATE OF short_id ON test_sessions
    FOR EACH ROW EXECUTE FUNCTION trg_assign_short_id('session_id');

COMMENT ON TRIGGER physical_samples_short_id ON physical_samples IS 'Assigns and protects short_id.';
COMMENT ON TRIGGER mfg_op_short_id ON manufacturing_operations IS 'Assigns and protects short_id.';
COMMENT ON TRIGGER test_sessions_short_id ON test_sessions IS 'Assigns and protects short_id.';

CREATE FUNCTION record_by_short_id(p_short_id TEXT)
    RETURNS TABLE (collection TEXT, record_id UUID)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $$
    SELECT s.collection, s.record_id
    FROM public.short_ids s
    WHERE s.short_id = lower(btrim(p_short_id))
      AND CASE s.collection
              WHEN 'physical_samples' THEN EXISTS (SELECT 1 FROM public.physical_samples p WHERE p.sample_id = s.record_id)
              WHEN 'manufacturing_operations' THEN EXISTS (SELECT 1 FROM public.manufacturing_operations m WHERE m.operation_id = s.record_id)
              WHEN 'test_sessions' THEN EXISTS (SELECT 1 FROM public.test_sessions t WHERE t.session_id = s.record_id)
          END;
$$;

COMMENT ON FUNCTION record_by_short_id(TEXT) IS
    'Finds the live record with this short ID (case-insensitive): its table and primary key. No row when unknown or deleted.';

INSERT INTO directus_fields (collection, field, interface, options, readonly, hidden, sort, width, note, searchable)
SELECT v.collection, 'short_id', 'input', '{"font":"monospace"}'::json, TRUE, FALSE, v.sort, 'half',
       'Permanent ID: never changes. Printed on labels; type it in the finder.', TRUE
FROM (VALUES ('physical_samples', 2), ('manufacturing_operations', 13), ('test_sessions', 1)) AS v (collection, sort)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = 'short_id');

-- migrate:down
DELETE FROM directus_fields
WHERE field = 'short_id' AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions');
DROP FUNCTION IF EXISTS record_by_short_id(TEXT);
DROP TRIGGER IF EXISTS test_sessions_short_id ON test_sessions;
DROP TRIGGER IF EXISTS mfg_op_short_id ON manufacturing_operations;
DROP TRIGGER IF EXISTS physical_samples_short_id ON physical_samples;
ALTER TABLE test_sessions DROP COLUMN IF EXISTS short_id;
ALTER TABLE manufacturing_operations DROP COLUMN IF EXISTS short_id;
ALTER TABLE physical_samples DROP COLUMN IF EXISTS short_id;
DROP FUNCTION IF EXISTS trg_assign_short_id();
DROP FUNCTION IF EXISTS claim_short_id(TEXT, UUID);
DROP TABLE IF EXISTS short_ids;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
ROUNDTRIP=1 bash scripts/dev/schema_test_docker.sh > /tmp/t0a-2.txt 2>&1
grep -A14 "Short IDs" /tmp/t0a-2.txt; tail -4 /tmp/t0a-2.txt
diff <(grep FAIL /tmp/t0a-baseline.txt) <(grep FAIL /tmp/t0a-2.txt)
```

Expected: all 12 short-ID checks PASS; the FAIL diff is empty; the roundtrip prints
`Rolling back: 20261010000150_short_ids.sql` and then `Applied: 20261010000150_short_ids.sql`
with no error.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/20261010000150_short_ids.sql tests/phase1_schema.sh
git commit -m "feat(db): permanent short IDs for samples, operations and tests

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration 151 — the primary subject is the earliest linked

**Files:**
- Create: `db/migrations/20261010000151_test_subject_linked_at.sql`
- Modify: `tests/phase1_schema.sh` (the "Test subject junction" section: one new check, one label)

**Interfaces:**
- Consumes: `sync_test_session_primary_subject(UUID)` from `20261007000139` (replaced here).
- Produces: column `test_sessions_subject.linked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()`;
  the sync orders by `(linked_at, id)`.

- [ ] **Step 1: Write the failing test**

In the "Test subject junction" section of `tests/phase1_schema.sh`, insert before the line
`-- delete the primary: the next subject is promoted`:

```sql
-- the earliest LINKED subject is the primary, even when a later one has a lower junction id
INSERT INTO test_sessions (session_id) VALUES ('c0000000-0000-4000-8000-0000000001c9');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-0000000000ff', 'c0000000-0000-4000-8000-0000000001c9', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a2');
INSERT INTO test_sessions_subject (id, test_sessions_id, collection, item)
VALUES ('00000000-0000-4000-8000-0000000000f1', 'c0000000-0000-4000-8000-0000000001c9', 'physical_samples', 'c0000000-0000-4000-8000-0000000001a1');
SELECT 'earliest:' || (sample_id = 'c0000000-0000-4000-8000-0000000001a2')
  FROM test_sessions WHERE session_id = 'c0000000-0000-4000-8000-0000000001c9';
```

(The second junction id `…f1` is lower than the first `…ff`; `…000000000001` is already used by
test `…1c2` in this section.) Then add after `ps_check "lowest_id:true" …`:

```bash
ps_check "earliest:true" "the earliest linked subject stays primary when a later one has a lower junction id"
```

and change the label of the `lowest_id` check (its data has the lower id linked first, so it
still passes) to:

```bash
ps_check "lowest_id:true" "of two subjects linked in turn, the first linked is the primary"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash scripts/dev/schema_test_docker.sh > /tmp/t0a-3.txt 2>&1; grep "earliest" /tmp/t0a-3.txt
```

Expected: `FAIL the earliest linked subject stays primary …`.

- [ ] **Step 3: Write the migration**

`db/migrations/20261010000151_test_subject_linked_at.sql`:

```sql
-- migrate:up
-- The primary subject of a test is the earliest linked one (stream T0a, spec §2, decision Q34).
--
-- Why: test codes (next migration) are built from the primary subject, and 20261007000139 picks
-- the subject with the lowest junction id, a random UUID: linking a second sample could make it
-- the primary and rename the test. The junction gets the time each row was linked, and the sync
-- orders by it (the id only breaks ties, e.g. rows that existed before this migration).

ALTER TABLE test_sessions_subject
    ADD COLUMN linked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

COMMENT ON COLUMN test_sessions_subject.linked_at IS
    'When this subject was linked to the test. The earliest valid subject is the test''s primary subject (sync_test_session_primary_subject).';

CREATE OR REPLACE FUNCTION sync_test_session_primary_subject(p_session_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    v_uuid_re CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_sample  UUID;
    v_edge    UUID;
    r         RECORD;
BEGIN
    IF p_session_id IS NULL THEN
        RETURN;
    END IF;

    PERFORM 1 FROM test_sessions WHERE session_id = p_session_id FOR UPDATE;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'physical_samples'
        ORDER BY s.linked_at, s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM physical_samples p WHERE p.sample_id = r.item::uuid) THEN
            v_sample := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'insert_edges'
        ORDER BY s.linked_at, s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM insert_edges e WHERE e.edge_id = r.item::uuid) THEN
            v_edge := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    UPDATE test_sessions
    SET sample_id = v_sample,
        insert_edge_id = v_edge
    WHERE session_id = p_session_id
      AND (sample_id IS DISTINCT FROM v_sample OR insert_edge_id IS DISTINCT FROM v_edge);
END;
$$;

COMMENT ON FUNCTION sync_test_session_primary_subject(UUID) IS
    'Recomputes test_sessions.sample_id and insert_edge_id (derived from test_sessions_subject (primary subject); do not write directly) for one test: the earliest linked valid subject of each kind.';

INSERT INTO directus_fields (collection, field, interface, readonly, hidden, note)
SELECT 'test_sessions_subject', 'linked_at', 'datetime', TRUE, TRUE, 'When the subject was linked; the earliest is the primary subject.'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'test_sessions_subject' AND field = 'linked_at');

-- migrate:down
DELETE FROM directus_fields WHERE collection = 'test_sessions_subject' AND field = 'linked_at';

CREATE OR REPLACE FUNCTION sync_test_session_primary_subject(p_session_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
AS $$
DECLARE
    v_uuid_re CONSTANT TEXT := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_sample  UUID;
    v_edge    UUID;
    r         RECORD;
BEGIN
    IF p_session_id IS NULL THEN
        RETURN;
    END IF;

    PERFORM 1 FROM test_sessions WHERE session_id = p_session_id FOR UPDATE;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'physical_samples'
        ORDER BY s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM physical_samples p WHERE p.sample_id = r.item::uuid) THEN
            v_sample := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    FOR r IN
        SELECT s.item
        FROM test_sessions_subject s
        WHERE s.test_sessions_id = p_session_id AND s.collection = 'insert_edges'
        ORDER BY s.id
    LOOP
        IF r.item ~* v_uuid_re
           AND EXISTS (SELECT 1 FROM insert_edges e WHERE e.edge_id = r.item::uuid) THEN
            v_edge := r.item::uuid;
            EXIT;
        END IF;
    END LOOP;

    UPDATE test_sessions
    SET sample_id = v_sample,
        insert_edge_id = v_edge
    WHERE session_id = p_session_id
      AND (sample_id IS DISTINCT FROM v_sample OR insert_edge_id IS DISTINCT FROM v_edge);
END;
$$;

COMMENT ON FUNCTION sync_test_session_primary_subject(UUID) IS
    'Recomputes test_sessions.sample_id and insert_edge_id (derived from test_sessions_subject (primary subject); do not write directly) for one test.';

ALTER TABLE test_sessions_subject DROP COLUMN IF EXISTS linked_at;
```

Before writing the down, diff the down's function body against `20261007000139`'s up body
(`awk` the two out and `diff`): they must be identical apart from whitespace, comments omitted.
The original also has two comment lines inside the body after `PERFORM` — copy the body from
`20261007000139` verbatim for the down rather than from this plan if they differ.

The `ps_check "comments:5"` check counts descriptions containing "derived from
test_sessions_subject (primary subject); do not write directly": the new function comment keeps
that phrase, so the count stays 5.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
ROUNDTRIP=1 bash scripts/dev/schema_test_docker.sh > /tmp/t0a-3.txt 2>&1
grep -E "earliest|first linked|comments:5|derived-column" /tmp/t0a-3.txt; tail -4 /tmp/t0a-3.txt
diff <(grep FAIL /tmp/t0a-baseline.txt) <(grep FAIL /tmp/t0a-3.txt)
```

Expected: `earliest` PASS, every existing "Test subject junction" and "Deleting samples and edges"
check still PASS, empty FAIL diff, clean roundtrip of 151.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/20261010000151_test_subject_linked_at.sql tests/phase1_schema.sh
git commit -m "feat(db): a test's primary subject is the earliest linked one

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Migration 152 — test codes

**Files:**
- Create: `db/migrations/20261010000152_test_codes.sql`
- Modify: `tests/phase1_schema.sh` (new section after the short-ID section from Task 2)

**Interfaces:**
- Consumes: `test_sessions_subject.linked_at` (Task 3); `short_id` columns (Task 2, untouched here).
- Produces (later stages and N1 rely on these names):
  - `test_sessions.test_code TEXT` (UNIQUE `test_sessions_test_code_unique`),
    `test_code_number INTEGER`, `test_code_type TEXT`, `test_code_is_manual BOOLEAN NOT NULL
    DEFAULT false`, `test_code_subject_collection TEXT`, `test_code_subject_id UUID`.
  - `test_type_code(p_test_type TEXT) RETURNS TEXT` (IMMUTABLE; NULL for unknown).
  - `test_code_subject(p_session_id UUID, OUT collection TEXT, OUT subject_id UUID, OUT subject_code TEXT)`.
  - table `test_code_counters` and `next_test_code_number(TEXT, UUID, TEXT) RETURNS INTEGER`.
  - triggers `test_sessions_set_code` (test_sessions), `physical_samples_cascade_test_codes`,
    `insert_edges_cascade_test_codes`. T0b extends the sample cascade to operations.

- [ ] **Step 1: Write the failing test**

Append after the `sid_check "comments:1" …` line:

```bash
echo "== Test codes: built from the earliest subject and the type, kept up to date (T0a) =="
tc_out=$($PSQL 2>&1 <<'SQL'
BEGIN;
INSERT INTO physical_samples (sample_id, sample_code) VALUES
    ('c0000000-0000-4000-8000-000000000211', 'TEST-TC-001'),
    ('c0000000-0000-4000-8000-000000000212', 'TEST-TC-002');
INSERT INTO people (person_id, full_name) VALUES ('c0000000-0000-4000-8000-000000000213', 'Test Code Owner');
INSERT INTO tool_boxes (tool_box_id, tool_box_code, owner_person_id)
VALUES ('c0000000-0000-4000-8000-000000000214', 'TEST-TC-BOX', 'c0000000-0000-4000-8000-000000000213');
INSERT INTO cutting_inserts (insert_id, insert_code, tool_box_id)
VALUES ('c0000000-0000-4000-8000-000000000215', 'TEST-TC-BOX-1', 'c0000000-0000-4000-8000-000000000214');
INSERT INTO insert_edges (edge_id, edge_code, insert_id, edge_identifier)
VALUES ('c0000000-0000-4000-8000-000000000216', 'TEST-TC-BOX-1A', 'c0000000-0000-4000-8000-000000000215', 'A');
INSERT INTO test_sessions (session_id, test_type) VALUES
    ('c0000000-0000-4000-8000-000000000221', 'sem'),
    ('c0000000-0000-4000-8000-000000000222', 'sem'),
    ('c0000000-0000-4000-8000-000000000223', 'sem'),
    ('c0000000-0000-4000-8000-000000000224', 'hardness'),
    ('c0000000-0000-4000-8000-000000000226', 'sem'),
    ('c0000000-0000-4000-8000-000000000228', NULL);
INSERT INTO test_sessions (session_id, test_type, test_code)
VALUES ('c0000000-0000-4000-8000-000000000225', 'sem', '  TEST-TC-001-SEM4 ');
CREATE TEMP VIEW tc AS SELECT session_id, coalesce(test_code, 'null') AS code, test_code_is_manual AS manual FROM test_sessions;

SELECT 'nocode:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000221', 'physical_samples', 'c0000000-0000-4000-8000-000000000211');
SELECT 'first:' || code || '/' || manual FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000221', 'physical_samples', 'c0000000-0000-4000-8000-000000000212');
SELECT 'second:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000222', 'physical_samples', 'c0000000-0000-4000-8000-000000000211');
SELECT 'next:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_code = test_code WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
SELECT 'resave:' || code || '/' || manual FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_type = 'xrd' WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
SELECT 'type:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000223', 'physical_samples', 'c0000000-0000-4000-8000-000000000211');
SELECT 'noreuse:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000223';
UPDATE test_sessions SET test_code = 'MY-CODE' WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
SELECT 'typed:' || code || '/' || manual FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_type = 'tem' WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
SELECT 'typed_kept:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
UPDATE test_sessions SET test_code = NULL WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
SELECT 'cleared:' || code || '/' || manual FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000222';
SELECT 'typed_insert:' || code || '/' || manual FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000225';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000226', 'physical_samples', 'c0000000-0000-4000-8000-000000000211');
SELECT 'skip_taken:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000226';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000224', 'insert_edges', 'c0000000-0000-4000-8000-000000000216');
SELECT 'edge:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000224';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000224', 'physical_samples', 'c0000000-0000-4000-8000-000000000211');
SELECT 'edge_kept:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000224';
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000228', 'physical_samples', 'not-a-uuid');
INSERT INTO test_sessions_subject (test_sessions_id, collection, item)
VALUES ('c0000000-0000-4000-8000-000000000228', 'physical_samples', 'C0000000-0000-4000-8000-000000000211');
SELECT 'notype:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000228';
UPDATE test_sessions SET test_type = 'dma' WHERE session_id = 'c0000000-0000-4000-8000-000000000228';
SELECT 'type_arrives:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000228';
SELECT 'junk_subject:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000228';
UPDATE physical_samples SET sample_code = 'TEST-TC-001B' WHERE sample_id = 'c0000000-0000-4000-8000-000000000211';
SELECT 'cascade:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000223';
SELECT 'cascade_typed:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000225';
SELECT 'cascade_edge_test:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000224';
UPDATE insert_edges SET edge_code = 'TEST-TC-BOX-1Z' WHERE edge_id = 'c0000000-0000-4000-8000-000000000216';
SELECT 'cascade_edge:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000224';
DELETE FROM test_sessions_subject
  WHERE test_sessions_id = 'c0000000-0000-4000-8000-000000000221' AND item = 'c0000000-0000-4000-8000-000000000211';
SELECT 'promoted:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
DELETE FROM test_sessions_subject WHERE test_sessions_id = 'c0000000-0000-4000-8000-000000000221';
SELECT 'orphan:' || code FROM tc WHERE session_id = 'c0000000-0000-4000-8000-000000000221';
DO $$ BEGIN
  INSERT INTO test_sessions (session_id, test_code) VALUES ('c0000000-0000-4000-8000-000000000229', 'TEST-TC-001B-SEM3');
  RAISE NOTICE 'unique:missing';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'unique:ok';
END $$;
SELECT 'directus:' || count(*) FROM directus_fields WHERE collection = 'test_sessions'
  AND field IN ('test_code', 'test_code_number', 'test_code_type', 'test_code_is_manual',
                'test_code_subject_collection', 'test_code_subject_id');
SELECT 'directus_visible:' || count(*) FROM directus_fields WHERE collection = 'test_sessions' AND field = 'test_code' AND NOT hidden;
ROLLBACK;
SQL
)
tc_check() { grep -q -- "$1" <<<"$tc_out" && ok "$2" || bad "$2 (psql output: $tc_out)"; }
tc_check "nocode:null$" "a test with no subject has no code"
tc_check "first:TEST-TC-001-SEM1/false$" "linking the first subject gives {sample code}-{TYPE}1, automatic"
tc_check "second:TEST-TC-001-SEM1$" "linking a second subject changes nothing"
tc_check "next:TEST-TC-001-SEM2$" "the next SEM test on the sample gets 2"
tc_check "resave:TEST-TC-001-SEM2/false$" "re-saving the same code keeps it automatic"
tc_check "type:TEST-TC-001-XRD1$" "a type change takes the next number of the new type"
tc_check "noreuse:TEST-TC-001-SEM3$" "a number that moved away is not handed out again"
tc_check "typed:MY-CODE/true$" "a typed code is kept and flagged as typed"
tc_check "typed_kept:MY-CODE$" "a typed code survives a type change"
tc_check "cleared:TEST-TC-001-TEM1/false$" "clearing a typed code goes back to automatic with the current type"
tc_check "typed_insert:TEST-TC-001-SEM4/true$" "a code given on insert is typed (and trimmed)"
tc_check "skip_taken:TEST-TC-001-SEM5$" "an automatic code skips a number someone typed by hand"
tc_check "edge:TEST-TC-BOX-1A-HRD1$" "an insert-edge subject uses the edge code"
tc_check "edge_kept:TEST-TC-BOX-1A-HRD1$" "adding a sample to an edge test keeps the edge-based code"
tc_check "notype:null$" "a test with a subject but no type has no code"
tc_check "type_arrives:TEST-TC-001-DMA1$" "setting the type gives the code (upper-case junction item accepted)"
tc_check "junk_subject:TEST-TC-001-DMA1$" "a junk junction item linked earlier is skipped when building the code"
tc_check "cascade:TEST-TC-001B-SEM3$" "a corrected sample code flows into its tests' automatic codes"
tc_check "cascade_typed:TEST-TC-001-SEM4$" "a typed code ignores a sample code change"
tc_check "cascade_edge_test:TEST-TC-BOX-1A-HRD1$" "a sample code change leaves an edge-based code alone"
tc_check "cascade_edge:TEST-TC-BOX-1Z-HRD1$" "a corrected edge code flows into its tests"
tc_check "promoted:TEST-TC-002-XRD1$" "removing the code's subject re-codes the test from the next subject"
tc_check "orphan:TEST-TC-002-XRD1$" "a test that loses all its subjects keeps its last code"
tc_check "unique:ok" "test codes are unique"
tc_check "directus:6$" "the six test-code fields are registered in Directus"
tc_check "directus_visible:1$" "only test_code is visible on the form"
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bash scripts/dev/schema_test_docker.sh > /tmp/t0a-4.txt 2>&1; grep -A3 "Test codes" /tmp/t0a-4.txt
```

Expected: FAIL lines (`column "test_code" … does not exist`).

- [ ] **Step 3: Write the migration**

`db/migrations/20261010000152_test_codes.sql`:

```sql
-- migrate:up
-- Test codes (stream T0a, spec docs/superpowers/specs/2026-10-10-record-codes-design.md §2).
--
-- Why: a test session had no code, so it could not be searched for, written on a sample bag or
-- named in a file. The code is {subject code}-{TYPE}{n}, e.g. 116-RK-MH-2024-12-18-SEM1:
--   * subject = the earliest linked valid subject of the test, sample or insert edge (across
--     both kinds, so adding a sample to an edge test does not rename it);
--   * n = the next number for (subject, type) from test_code_counters, never reused;
--   * the code follows the subject and the type: a new number when either changes, the same
--     number when only the subject's own code is corrected (cascade triggers below);
--   * a code written by a person is kept (test_code_is_manual); clearing it goes back to
--     automatic; a test that loses all its subjects keeps its last code.
-- The number is drawn when a subject is linked: Directus inserts the test first and the
-- junction rows after, and the junction's sync issues the UPDATE this trigger acts on.

ALTER TABLE test_sessions
    ADD COLUMN test_code TEXT,
    ADD COLUMN test_code_number INTEGER CHECK (test_code_number > 0),
    ADD COLUMN test_code_type TEXT,
    ADD COLUMN test_code_is_manual BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN test_code_subject_collection TEXT
        CHECK (test_code_subject_collection IN ('physical_samples', 'insert_edges')),
    ADD COLUMN test_code_subject_id UUID,
    ADD CONSTRAINT test_sessions_test_code_unique UNIQUE (test_code);

COMMENT ON COLUMN test_sessions.test_code IS
    'Readable test code, {subject code}-{TYPE}{n} (e.g. 116-RK-MH-2024-12-18-SEM1). Assigned by the database when the first subject is linked; follows the subject and type unless typed by hand (test_code_is_manual). Unique.';
COMMENT ON COLUMN test_sessions.test_code_number IS 'The n of an automatic test_code, drawn from test_code_counters.';
COMMENT ON COLUMN test_sessions.test_code_type IS 'The test_type the current number was drawn for; a different test_type draws a new number.';
COMMENT ON COLUMN test_sessions.test_code_is_manual IS 'True when test_code was written by a person: it is then kept as written. Clearing test_code sets it back to false.';
COMMENT ON COLUMN test_sessions.test_code_subject_collection IS 'Kind of subject the automatic code is built on: physical_samples or insert_edges.';
COMMENT ON COLUMN test_sessions.test_code_subject_id IS 'The subject the automatic code is built on (sample_id or edge_id; no FK, the subject may be removed and the code kept).';

CREATE FUNCTION test_type_code(p_test_type TEXT)
    RETURNS TEXT
    LANGUAGE sql
    IMMUTABLE
AS $$
    SELECT CASE p_test_type
        WHEN 'tensile' THEN 'TEN' WHEN 'hardness' THEN 'HRD' WHEN 'charpy' THEN 'CHP'
        WHEN 'compression' THEN 'CMP' WHEN 'tribology' THEN 'TRB' WHEN 'optical_microscopy' THEN 'OM'
        WHEN 'sem' THEN 'SEM' WHEN 'tem' THEN 'TEM' WHEN 'xrd' THEN 'XRD' WHEN 'alicona' THEN 'ALI'
        WHEN 'clemx' THEN 'CLX' WHEN 'dct' THEN 'DCT' WHEN 'ct_scan' THEN 'CT' WHEN 'fatigue' THEN 'FAT'
        WHEN 'creep' THEN 'CRP' WHEN 'dma' THEN 'DMA' WHEN 'other' THEN 'OTH'
    END;
$$;

COMMENT ON FUNCTION test_type_code(TEXT) IS 'The test-code abbreviation of a test_type (sem -> SEM, hardness -> HRD ...); NULL for an unknown or missing type.';

CREATE FUNCTION test_code_subject(p_session_id UUID, OUT collection TEXT, OUT subject_id UUID, OUT subject_code TEXT)
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
AS $$
    SELECT s.collection, coalesce(p.sample_id, e.edge_id), coalesce(p.sample_code, e.edge_code)
    FROM public.test_sessions_subject s
    LEFT JOIN public.physical_samples p
           ON s.collection = 'physical_samples'
          AND p.sample_id = CASE WHEN s.item ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 THEN lower(s.item)::uuid END
    LEFT JOIN public.insert_edges e
           ON s.collection = 'insert_edges'
          AND e.edge_id = CASE WHEN s.item ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                               THEN lower(s.item)::uuid END
    WHERE s.test_sessions_id = p_session_id
      AND (p.sample_id IS NOT NULL OR e.edge_id IS NOT NULL)
    ORDER BY s.linked_at, s.id
    LIMIT 1;
$$;

COMMENT ON FUNCTION test_code_subject(UUID) IS
    'The subject a test''s code is built on: its earliest linked valid subject, sample or insert edge, with that subject''s code. No row when it has none.';

CREATE TABLE test_code_counters (
    subject_collection TEXT NOT NULL CHECK (subject_collection IN ('physical_samples', 'insert_edges')),
    subject_id         UUID NOT NULL,
    test_type          TEXT NOT NULL,
    last_number        INTEGER NOT NULL CHECK (last_number > 0),
    PRIMARY KEY (subject_collection, subject_id, test_type)
);

COMMENT ON TABLE test_code_counters IS
    'Bookkeeping for test codes: the last number handed out per (subject, test type), so a number is never handed out twice. Written only by next_test_code_number(); no OCC or audit (no user edits it).';
COMMENT ON COLUMN test_code_counters.subject_collection IS 'physical_samples or insert_edges.';
COMMENT ON COLUMN test_code_counters.subject_id IS 'The sample or edge (no FK: the counter outlives a deleted subject, which keeps numbers from being reused).';
COMMENT ON COLUMN test_code_counters.test_type IS 'The test_type the numbers are for.';
COMMENT ON COLUMN test_code_counters.last_number IS 'The highest number handed out so far.';

CREATE FUNCTION next_test_code_number(p_collection TEXT, p_subject_id UUID, p_test_type TEXT)
    RETURNS INTEGER
    LANGUAGE sql
    SET search_path = pg_catalog, public
AS $$
    INSERT INTO public.test_code_counters AS c (subject_collection, subject_id, test_type, last_number)
    VALUES (p_collection, p_subject_id, p_test_type, 1)
    ON CONFLICT (subject_collection, subject_id, test_type)
    DO UPDATE SET last_number = c.last_number + 1
    RETURNING c.last_number;
$$;

COMMENT ON FUNCTION next_test_code_number(TEXT, UUID, TEXT) IS
    'Hands out the next test-code number for (subject, test type); the counter row lock serialises concurrent callers.';

CREATE FUNCTION trg_test_sessions_set_code()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
DECLARE
    v_sub  RECORD;
    v_abbr TEXT;
    v_n    INTEGER;
    v_code TEXT;
BEGIN
    -- Fast exit: nothing the code depends on changed.
    IF TG_OP = 'UPDATE'
       AND NEW.test_code IS NOT DISTINCT FROM OLD.test_code
       AND NEW.test_code_is_manual IS NOT DISTINCT FROM OLD.test_code_is_manual
       AND NEW.test_type IS NOT DISTINCT FROM OLD.test_type
       AND NEW.sample_id IS NOT DISTINCT FROM OLD.sample_id
       AND NEW.insert_edge_id IS NOT DISTINCT FROM OLD.insert_edge_id THEN
        RETURN NEW;
    END IF;

    -- 1. A code written by a person is kept; a cleared code goes back to automatic.
    IF TG_OP = 'INSERT' THEN
        IF nullif(btrim(NEW.test_code), '') IS NOT NULL THEN
            NEW.test_code := btrim(NEW.test_code);
            NEW.test_code_is_manual := TRUE;
            RETURN NEW;
        END IF;
        NEW.test_code := NULL;
        NEW.test_code_is_manual := FALSE;
    ELSIF NEW.test_code IS DISTINCT FROM OLD.test_code THEN
        IF nullif(btrim(NEW.test_code), '') IS NULL THEN
            NEW.test_code := NULL;
            NEW.test_code_is_manual := FALSE;
        ELSE
            NEW.test_code := btrim(NEW.test_code);
            NEW.test_code_is_manual := TRUE;
            RETURN NEW;
        END IF;
    END IF;

    -- 2. Typed codes are left alone.
    IF NEW.test_code_is_manual THEN
        RETURN NEW;
    END IF;

    -- 3. No subject (or no type): keep whatever code there is.
    SELECT * INTO v_sub FROM public.test_code_subject(NEW.session_id);
    v_abbr := public.test_type_code(NEW.test_type);
    IF v_sub.subject_id IS NULL OR v_sub.subject_code IS NULL OR v_abbr IS NULL THEN
        RETURN NEW;
    END IF;

    -- 4. New subject, new type or no number yet: draw the next free number.
    IF NEW.test_code_number IS NULL
       OR NEW.test_code_subject_collection IS DISTINCT FROM v_sub.collection
       OR NEW.test_code_subject_id IS DISTINCT FROM v_sub.subject_id
       OR NEW.test_code_type IS DISTINCT FROM NEW.test_type THEN
        LOOP
            v_n := public.next_test_code_number(v_sub.collection, v_sub.subject_id, NEW.test_type);
            v_code := v_sub.subject_code || '-' || v_abbr || v_n;
            -- skip a number someone typed by hand on another test
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.test_sessions t
                                  WHERE t.test_code = v_code AND t.session_id <> NEW.session_id);
        END LOOP;
        NEW.test_code_number := v_n;
        NEW.test_code_type := NEW.test_type;
        NEW.test_code_subject_collection := v_sub.collection;
        NEW.test_code_subject_id := v_sub.subject_id;
        NEW.test_code := v_code;
    ELSE
        -- 5. Same subject, type and number: follow the subject's (possibly corrected) code.
        NEW.test_code := v_sub.subject_code || '-' || v_abbr || NEW.test_code_number;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION trg_test_sessions_set_code() IS
    'BEFORE INSERT / UPDATE on test_sessions: keeps test_code = {subject code}-{TYPE}{n} up to date (spec 2026-10-10-record-codes §2). Typed codes are kept; clearing the code returns to automatic.';

CREATE TRIGGER test_sessions_set_code
    BEFORE INSERT OR UPDATE ON test_sessions
    FOR EACH ROW EXECUTE FUNCTION trg_test_sessions_set_code();

COMMENT ON TRIGGER test_sessions_set_code ON test_sessions IS 'Assigns and updates the automatic test_code.';

-- A corrected subject code flows into the automatic codes built on it (same numbers): clearing
-- the code makes the trigger above rebuild it with the number it already has.
CREATE FUNCTION trg_cascade_test_codes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_TABLE_NAME = 'physical_samples' THEN
        UPDATE public.test_sessions
        SET test_code = NULL
        WHERE NOT test_code_is_manual
          AND test_code_subject_collection = 'physical_samples'
          AND test_code_subject_id = NEW.sample_id;
    ELSE
        UPDATE public.test_sessions
        SET test_code = NULL
        WHERE NOT test_code_is_manual
          AND test_code_subject_collection = 'insert_edges'
          AND test_code_subject_id = NEW.edge_id;
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION trg_cascade_test_codes() IS
    'AFTER UPDATE OF sample_code / edge_code: rebuilds the automatic test codes built on that subject, keeping their numbers.';

CREATE TRIGGER physical_samples_cascade_test_codes
    AFTER UPDATE OF sample_code ON physical_samples
    FOR EACH ROW WHEN (OLD.sample_code IS DISTINCT FROM NEW.sample_code)
    EXECUTE FUNCTION trg_cascade_test_codes();
CREATE TRIGGER insert_edges_cascade_test_codes
    AFTER UPDATE OF edge_code ON insert_edges
    FOR EACH ROW WHEN (OLD.edge_code IS DISTINCT FROM NEW.edge_code)
    EXECUTE FUNCTION trg_cascade_test_codes();

COMMENT ON TRIGGER physical_samples_cascade_test_codes ON physical_samples IS 'A corrected sample code flows into its tests'' automatic codes.';
COMMENT ON TRIGGER insert_edges_cascade_test_codes ON insert_edges IS 'A corrected edge code flows into its tests'' automatic codes.';

INSERT INTO directus_fields (collection, field, interface, options, readonly, hidden, sort, width, note, searchable)
SELECT v.collection, v.field, v.interface, v.options::json, v.readonly, v.hidden, v.sort, v.width, v.note, TRUE
FROM (VALUES
    ('test_sessions', 'test_code', 'input',
     '{"placeholder":"Assigned automatically when a subject is linked","trim":true,"font":"monospace"}',
     FALSE, FALSE, 1, 'half',
     'Follows the subject and the test type. Type your own to keep it fixed; clear it to go back to automatic.'),
    ('test_sessions', 'test_code_number', 'input', NULL, TRUE, TRUE, 900, 'full', NULL),
    ('test_sessions', 'test_code_type', 'input', NULL, TRUE, TRUE, 901, 'full', NULL),
    ('test_sessions', 'test_code_is_manual', 'boolean', NULL, TRUE, TRUE, 902, 'full', NULL),
    ('test_sessions', 'test_code_subject_collection', 'input', NULL, TRUE, TRUE, 903, 'full', NULL),
    ('test_sessions', 'test_code_subject_id', 'input', NULL, TRUE, TRUE, 904, 'full', NULL)
) AS v (collection, field, interface, options, readonly, hidden, sort, width, note)
WHERE NOT EXISTS (SELECT 1 FROM directus_fields f WHERE f.collection = v.collection AND f.field = v.field);

-- migrate:down
DELETE FROM directus_fields
WHERE collection = 'test_sessions'
  AND field IN ('test_code', 'test_code_number', 'test_code_type', 'test_code_is_manual',
                'test_code_subject_collection', 'test_code_subject_id');
DROP TRIGGER IF EXISTS insert_edges_cascade_test_codes ON insert_edges;
DROP TRIGGER IF EXISTS physical_samples_cascade_test_codes ON physical_samples;
DROP FUNCTION IF EXISTS trg_cascade_test_codes();
DROP TRIGGER IF EXISTS test_sessions_set_code ON test_sessions;
DROP FUNCTION IF EXISTS trg_test_sessions_set_code();
DROP FUNCTION IF EXISTS next_test_code_number(TEXT, UUID, TEXT);
DROP TABLE IF EXISTS test_code_counters;
DROP FUNCTION IF EXISTS test_code_subject(UUID);
DROP FUNCTION IF EXISTS test_type_code(TEXT);
ALTER TABLE test_sessions
    DROP CONSTRAINT IF EXISTS test_sessions_test_code_unique,
    DROP COLUMN IF EXISTS test_code_subject_id,
    DROP COLUMN IF EXISTS test_code_subject_collection,
    DROP COLUMN IF EXISTS test_code_is_manual,
    DROP COLUMN IF EXISTS test_code_type,
    DROP COLUMN IF EXISTS test_code_number,
    DROP COLUMN IF EXISTS test_code;
```

Notes for the implementer:
- Step 5 (`cascade`) works because the cascade sets `test_code = NULL`: the trigger treats that as
  "cleared", sets `test_code_is_manual = false` (already false), and since subject, type and
  number are unchanged it takes branch 5 and rebuilds with the same number.
- `promoted`: deleting the junction row of sample …211 from test …221 makes the sync set
  `sample_id` to …212; the trigger sees a different subject, draws (…212, xrd) → 1.
- `cascade_edge_test`: test …224's code is built on the edge (linked first), so the sample-code
  cascade, which only touches `test_code_subject_collection = 'physical_samples'`, leaves it.
- If `skip_taken` gives SEM4, the typed-code check in branch 4 is missing.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
ROUNDTRIP=3 bash scripts/dev/schema_test_docker.sh > /tmp/t0a-4.txt 2>&1
grep -A28 "Test codes" /tmp/t0a-4.txt; tail -8 /tmp/t0a-4.txt
diff <(grep FAIL /tmp/t0a-baseline.txt) <(grep FAIL /tmp/t0a-4.txt)
```

Expected: all 26 test-code checks PASS, the short-ID and subject sections still PASS, empty FAIL
diff, and the roundtrip rolls back 152, 151, 150 and applies them again without an error.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/20261010000152_test_codes.sql tests/phase1_schema.sh
git commit -m "feat(db): test codes built from the subject and type, kept up to date by the database

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Data dictionary and the stage's own checks

**Files:**
- Modify: `docs/data-dictionary.md` (sections `physical_samples`, `manufacturing_operations`,
  `test_sessions`, "Dual identifier pattern"; new subsections for `short_ids` and
  `test_code_counters` after `test_sessions`)
- Modify: `docs/superpowers/plans/2026-10-09-explorer-round-2.md` (status row T0)

- [ ] **Step 1: Document the columns and tables**

In `docs/data-dictionary.md`, add rows in each table's existing format for: `short_id` (three
tables); `test_code`, `test_code_number`, `test_code_type`, `test_code_is_manual`,
`test_code_subject_collection`, `test_code_subject_id` (`test_sessions`); `linked_at`
(`test_sessions_subject`, in the `test_sessions` section). Add subsections `short_ids` and
`test_code_counters` with their columns, copying the wording of the migration COMMENTs. In
"Dual identifier pattern", add one paragraph:

```markdown
**Short IDs.** Samples, operations and tests also carry `short_id`: the first 8 hex characters of
the UUID (more only after a clash), unique across the three tables through the `short_ids`
registry, never changed and never reused. It is the handle for labels, the finder and notes; the
readable codes (`sample_code`, `pass_code`, `test_code`) may change when their fields do.
```

- [ ] **Step 2: Run the full harness once more, with all three migrations round-tripped**

```bash
ROUNDTRIP=3 bash scripts/dev/schema_test_docker.sh > /tmp/t0a-5.txt 2>&1
tail -6 /tmp/t0a-5.txt
diff <(grep FAIL /tmp/t0a-baseline.txt) <(grep FAIL /tmp/t0a-5.txt)
```

Expected: `Results:` with exactly the baseline's 4 failures (empty diff), clean roundtrip.

- [ ] **Step 3: Update the stream status**

In `docs/superpowers/plans/2026-10-09-explorer-round-2.md`, change the T0 status cell to:
`**T0a built** on feat/record-codes (migrations 150-152, short IDs and test codes); awaiting Opus
review; T0b next`.

- [ ] **Step 4: Commit**

```bash
git add docs/data-dictionary.md docs/superpowers/plans/2026-10-09-explorer-round-2.md
git commit -m "docs: short IDs and test codes in the data dictionary; T0a status

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6 (coordinator, not a worker): review, check, dry run, apply, check live

- [ ] Opus review of `feat/record-codes` against `feat/explorer-restyle` with the repo's
  `migration-review` checklist (base ref: the merge commit's first parent), plus the six
  "Decisions this plan makes" above for explicit sign-off.
- [ ] **Pre-checks on live (read-only).** Each must return 0, or migration 150 is blocked until the
  cause is fixed (run by the controller on 2026-10-10: all 0):
  - `SELECT count(*) FROM manufacturing_operations WHERE pass_code ~ '\{(seq|mf)\}';`
  - `SELECT count(*) FROM physical_samples WHERE sample_code ~ '\{seq\}';`
  - duplicate UUIDs across the three tables (one registry, so a UUID must not appear twice):
    `SELECT id FROM (SELECT sample_id id FROM physical_samples UNION ALL SELECT operation_id FROM
    manufacturing_operations UNION ALL SELECT session_id FROM test_sessions) x GROUP BY id HAVING
    count(*) > 1;` (no rows)
  - user triggers not in their normal state on the three tables (the back-fill refuses them):
    `SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> 'O' AND tgrelid IN
    ('physical_samples'::regclass, 'manufacturing_operations'::regclass, 'test_sessions'::regclass);`
- [ ] **Dry run on a restored copy.** `pg_dump -Fc` of the live DB restored into a scratch container,
  `dbmate up` (time migration 150: that is the live lock window; it holds `lock_timeout = 10s`
  and ACCESS EXCLUSIVE on the three tables while it back-fills). Post-checks, all against the copy:
  - `SELECT length(short_id), count(*) FROM short_ids GROUP BY 1;` (8 for nearly all rows; longer
    only on a clash)
  - `SELECT count(*) FROM short_ids` = samples + operations + tests;
  - every user trigger on the three tables back to `'O'` (the pre-check query above returns 0);
  - `sum(version)` of the three tables and `count(*)` of `audit_logs` taken before `dbmate up` equal
    the values after migration 150 (the back-fill must not bump versions or write audit rows).
- [ ] **Backup** of the touched tables on live: `pg_dump -Fc -t physical_samples -t
  manufacturing_operations -t test_sessions -t test_sessions_subject -t directus_fields` into
  `backups/pre_t0a_<UTC timestamp>.dump`.
- [ ] **Apply in a quiet window.** Stop Directus (`docker stop d1-database-directus-1`) and any
  crawler or importer that writes to the three tables. Copy the three migration files into the
  main checkout's `db/migrations` (untracked, as for 143), `dbmate status` shows exactly 150-152
  pending, then `dbmate up`. Apply only through dbmate: it runs each migration in one transaction,
  while `psql -f` failing mid-back-fill would leave the user triggers disabled. Then start
  Directus (`docker start d1-database-directus-1`, or `docker restart` if it was left running).
- [ ] **Live check:** the sample, operation and test forms show a read-only **Short ID**; a new test
  with a linked sample gets `{sample code}-SEM1`; typing a code keeps it; "Save as copy" on a coded
  test that keeps the copied code is refused as a duplicate (codes are unique), and the same copy
  with the code box cleared gets the next number (`{sample code}-SEM2`), not the source's code.
- Dry run done 2026-10-10 on a copy of live (directus_revisions / directus_activity data left out):
  migration 150 took 0.45 s, all three 1.3 s; 10,445 short IDs, all 8 characters; `sum(version)`
  119,408 and 140,897 audit rows unchanged; all triggers back to 'O'; 10 Directus field rows.
  Pre-checks on live the same day: all 0.
