-- migrate:up
-- Found files and the Inbox (stream A of docs/superpowers/plans/2026-10-15-found-files-inbox.md; schema contract:
-- section 4 of docs/superpowers/specs/2026-10-15-found-files-inbox-design.md; decision: ADR-0020).
--
-- Why: people save instrument output in their own folder on the lab share, and nothing notices it. A read-only
-- inbox crawler (scripts/inbox_crawler/, stream C) lists each person's folder (Users/<uni alias>) and each team's
-- folder (Shared/<share folder>), registers new files and tags what they look like and which record they name; the
-- d1-inbox endpoint (stream B) lets a person link them in STARbase's Inbox (stream D). This migration is the schema.
--
--   * people.uni_alias, people.scan_while_former   whose folder under Users/ is theirs, and whether a Former person is still scanned;
--   * teams.share_folder                           which folder under Shared/ is the team's;
--   * d1_private.file_candidates                   one row per file found, with what it looks like, what it names and the undo bookkeeping;
--   * d1_private.inbox_dirs                        the folder cache that makes the scan incremental and marks a first scan (baseline);
--   * d1_private.inbox_scan_requests               the "Rescan my folder" / "Scan all" queue the daemon claims;
--   * d1_private.inbox_crawler_state               the singleton control and status row (like force_crawler_state, migration 77);
--   * d1_private.inbox_prefs                       the per-person auto-link opt-in (see the choice below).
--
-- The five tables are in d1_private (migration 141): outside the Directus schema scan, so Directus never lists them as
-- collections and candidates are never readable through its REST API; not in v_schema_dictionary; not granted to
-- d1_llm_readonly. They are reached only through the d1-inbox endpoint (people) and the crawler (the database role).
-- None has an audit trigger or an OCC column, as with the other d1_private tables (migrations 163, 170): they are derived,
-- recomputable bookkeeping, and the state moves with plain conditional UPDATEs (UPDATE ... WHERE state = 'new', so two
-- members racing for a team's file get one winner). What matters for audit is audited where it lands: the link itself is
-- a row in a junction table (sample_data_files, operation_data_files, session_data_files), which has its own audit trigger.
--
-- Auto-link opt-in: a NEW table d1_private.inbox_prefs (user_id, auto_link), not user_prefs (migration 170). user_prefs.prefs
-- is a JSON document owned by the d1-usage endpoint, which rejects keys it does not know, so a key written by d1-inbox
-- would be refused or dropped by the other endpoint, and one JSON blob makes "who opted in" a JSON scan instead of a column.
-- A real boolean also gives the crawler's "people with auto-link on" query an index-friendly shape.
--
-- Differences from the spec's section 4 (the spec is updated in the same commit):
--   * teams are keyed by team_id, not id: FKs are teams (team_id);
--   * extra CHECKs the spec did not list: an alias that starts with a dot and a folder made only of dots ('..' would walk out
--     of Users/ or Shared/, '.snapshot' is a hidden system folder), a folder with leading or trailing blanks,
--     kind_confidence between 0 and 1, matches a JSON array, extracted a JSON object, a suggestion names both a collection and
--     a record, size not negative, a candidate is not its own duplicate, a person-scope request names a person;
--   * extra columns: file_candidates.adopted_at (the "linking a document sets a flag the crawler reads to hash it once" of
--     plan task B2, which the spec had no column for), inbox_crawler_state.unmatched_folders (where the crawler records the
--     folders under Users/ and Shared/ that match nobody, for the admin list: inbox_dirs rows must have an owner) and
--     updated_at on the state and prefs rows;
--   * decided_by and requested_by are real foreign keys to directus_users (ON DELETE SET NULL), not bare uuids;
--   * the singleton starts 'running' (not 'paused' as force_crawler_state does): the daemon is already opt-in through
--     the compose profile, and the admin tab has no switch to start it.
SET LOCAL lock_timeout = '10s';

-- 1. People and teams: whose folder is whose.
ALTER TABLE people
    ADD COLUMN uni_alias TEXT,
    ADD COLUMN scan_while_former BOOLEAN NOT NULL DEFAULT false,
    ADD CONSTRAINT people_uni_alias_format_check CHECK (uni_alias ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{1,63}$');
CREATE UNIQUE INDEX people_uni_alias_key ON people (lower(uni_alias)) WHERE uni_alias IS NOT NULL;

ALTER TABLE teams
    ADD COLUMN share_folder TEXT,
    ADD CONSTRAINT teams_share_folder_format_check CHECK (share_folder !~ '[\\/]' AND btrim(share_folder) <> ''),
    ADD CONSTRAINT teams_share_folder_trim_check CHECK (share_folder = btrim(share_folder)),
    ADD CONSTRAINT teams_share_folder_not_dots_check CHECK (share_folder !~ '^[.]+$');
CREATE UNIQUE INDEX teams_share_folder_key ON teams (lower(share_folder)) WHERE share_folder IS NOT NULL;

COMMENT ON COLUMN people.uni_alias IS 'The name of this person''s personal folder on the lab share (Users/<uni alias>), which the inbox crawler scans for found files. 2 to 64 characters from letters, digits, dot, underscore and hyphen, not starting with a dot (so neither ''..'' nor a hidden folder such as ''.snapshot''). Unique ignoring case. Set by an administrator; NULL means the person has no folder to scan. migration 193.';
COMMENT ON COLUMN people.scan_while_former IS 'True when the inbox crawler should keep scanning this person''s folder after they are marked inactive (a Former person). Default false: a Former person''s folder is not scanned. Set by an administrator. migration 193.';
COMMENT ON COLUMN teams.share_folder IS 'The name of this team''s folder on the lab share (Shared/<share folder>), which the inbox crawler scans for found files. A single folder name: no slash or backslash, not blank, no leading or trailing blanks, not only dots. Unique ignoring case. NULL means the team has no folder to scan. migration 193.';
COMMENT ON INDEX people_uni_alias_key IS 'Two people cannot share a uni alias, ignoring case; people without an alias are not constrained.';
COMMENT ON INDEX teams_share_folder_key IS 'Two teams cannot share a share folder, ignoring case; teams without a folder are not constrained.';

-- A new person row cannot carry an alias or the Former switch. The Lab Member create permission on people lists no fields
-- (everything is allowed), so without this guard any Lab Member could create a login-less person that squats on a folder
-- name before an administrator assigns it. An administrator sets both columns afterwards with an UPDATE, which Lab Members
-- cannot do (their people update field list leaves these columns out).
CREATE FUNCTION d1_private.people_inbox_columns_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.uni_alias IS NOT NULL OR NEW.scan_while_former THEN
        RAISE EXCEPTION 'uni_alias and scan_while_former can only be set by an update'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;
COMMENT ON FUNCTION d1_private.people_inbox_columns_insert_guard() IS 'Trigger function (migration 193): refuses a new people row that sets uni_alias or scan_while_former, so only an update (an administrator; Lab Members cannot update these columns) can give a person an inbox folder.';
CREATE TRIGGER people_inbox_columns_insert BEFORE INSERT ON people
    FOR EACH ROW EXECUTE FUNCTION d1_private.people_inbox_columns_insert_guard();

-- 2. Found files.
CREATE TABLE d1_private.file_candidates (
    candidate_id        UUID          NOT NULL DEFAULT gen_random_uuid(),
    directus_files_id   UUID          NOT NULL,
    owner_person_id     UUID,
    owner_team_id       UUID,
    kind                TEXT          NOT NULL,
    kind_confidence     NUMERIC(4, 3),
    extracted           JSONB         NOT NULL DEFAULT '{}',
    origin              TEXT          NOT NULL,
    state               TEXT          NOT NULL DEFAULT 'new',
    match_strength      TEXT          NOT NULL DEFAULT 'none',
    matches             JSONB         NOT NULL DEFAULT '[]',
    suggested_collection TEXT,
    suggested_record_id UUID,
    duplicate_of        UUID,
    rel_path            TEXT          NOT NULL,
    size_bytes          BIGINT,
    source_mtime        TIMESTAMPTZ,
    first_seen_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    decided_at          TIMESTAMPTZ,
    decided_by          UUID,
    link_kind           TEXT,
    linked_collection   TEXT,
    linked_junction_id  UUID,
    link_batch_id       UUID,
    adopted_at          TIMESTAMPTZ,
    CONSTRAINT file_candidates_pkey PRIMARY KEY (candidate_id),
    CONSTRAINT file_candidates_directus_files_id_key UNIQUE (directus_files_id),
    CONSTRAINT file_candidates_directus_files_id_fkey FOREIGN KEY (directus_files_id) REFERENCES directus_files (id) ON DELETE CASCADE,
    CONSTRAINT file_candidates_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT file_candidates_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES teams (team_id) ON DELETE CASCADE,
    CONSTRAINT file_candidates_duplicate_of_fkey FOREIGN KEY (duplicate_of) REFERENCES d1_private.file_candidates (candidate_id) ON DELETE SET NULL,
    CONSTRAINT file_candidates_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES directus_users (id) ON DELETE SET NULL,
    CONSTRAINT file_candidates_one_owner_check CHECK (num_nonnulls(owner_person_id, owner_team_id) = 1),
    CONSTRAINT file_candidates_kind_check CHECK (kind IN ('sem_image', 'surface_scan', 'image', 'document', 'other')),
    CONSTRAINT file_candidates_kind_confidence_check CHECK (kind_confidence BETWEEN 0 AND 1),
    CONSTRAINT file_candidates_extracted_object_check CHECK (jsonb_typeof(extracted) = 'object'),
    CONSTRAINT file_candidates_origin_check CHECK (origin IN ('new', 'backlog')),
    CONSTRAINT file_candidates_state_check CHECK (state IN ('new', 'linked', 'dismissed', 'gone')),
    CONSTRAINT file_candidates_match_strength_check CHECK (match_strength IN ('short_id', 'code', 'edge_code', 'none')),
    CONSTRAINT file_candidates_matches_array_check CHECK (jsonb_typeof(matches) = 'array'),
    CONSTRAINT file_candidates_suggestion_pair_check CHECK ((suggested_collection IS NULL) = (suggested_record_id IS NULL)),
    CONSTRAINT file_candidates_not_own_duplicate_check CHECK (duplicate_of IS DISTINCT FROM candidate_id),
    CONSTRAINT file_candidates_size_bytes_check CHECK (size_bytes >= 0),
    CONSTRAINT file_candidates_link_kind_check CHECK (link_kind IN ('manual', 'bulk', 'auto')),
    CONSTRAINT file_candidates_linked_bookkeeping_check CHECK (state <> 'linked' OR (link_kind IS NOT NULL AND linked_collection IS NOT NULL
        AND linked_junction_id IS NOT NULL AND link_batch_id IS NOT NULL)),
    CONSTRAINT file_candidates_unlinked_bookkeeping_check CHECK (state = 'linked' OR (link_kind IS NULL AND linked_collection IS NULL
        AND linked_junction_id IS NULL AND link_batch_id IS NULL))
);
CREATE INDEX idx_file_candidates_owner_person_state ON d1_private.file_candidates (owner_person_id, state);
CREATE INDEX idx_file_candidates_owner_team_state ON d1_private.file_candidates (owner_team_id, state);
CREATE INDEX idx_file_candidates_link_batch ON d1_private.file_candidates (link_batch_id) WHERE link_batch_id IS NOT NULL;
CREATE INDEX idx_file_candidates_suggested_record ON d1_private.file_candidates (suggested_record_id) WHERE suggested_record_id IS NOT NULL;
CREATE INDEX idx_file_candidates_duplicate_of ON d1_private.file_candidates (duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX idx_file_candidates_adopted ON d1_private.file_candidates (adopted_at) WHERE adopted_at IS NOT NULL;
CREATE INDEX idx_file_candidates_decided_by ON d1_private.file_candidates (decided_by) WHERE decided_by IS NOT NULL;

COMMENT ON TABLE d1_private.file_candidates IS 'One row per file the inbox crawler found in a person''s or a team''s folder on the lab share, until a person links, dismisses or loses it (migration 193; spec 2026-10-15-found-files-inbox-design.md section 4). Written by the crawler (database role) and by the d1-inbox endpoint, which is the only reader for people: d1_private is outside the Directus schema scan, so candidates are never readable through its REST API. Derived bookkeeping: no audit trigger (the link itself is audited on its junction row). The file bytes stay on the share; the directus_files row is only a pointer.';
COMMENT ON COLUMN d1_private.file_candidates.candidate_id IS 'Surrogate key of the found file.';
COMMENT ON COLUMN d1_private.file_candidates.directus_files_id IS 'The pointer row in directus_files (storage star, uuid5-of-relative-path id, written by the crawler with the indexer''s rule). One candidate per file (unique); deleted with the file.';
COMMENT ON COLUMN d1_private.file_candidates.owner_person_id IS 'The person whose personal folder (Users/<uni alias>) the file was found in, or NULL for a team file; exactly one of owner_person_id and owner_team_id is set. Rows go with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.file_candidates.owner_team_id IS 'The team whose folder (Shared/<share folder>) the file was found in, or NULL for a personal file; exactly one of owner_person_id and owner_team_id is set. Rows go with the team (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.file_candidates.kind IS 'What the file looks like: sem_image (a possible SEM image), surface_scan (an Alicona .al3d file), image (another image), document (a pdf, Word, Excel, csv or text file) or other (anything else, such as .mat). Documents and others are never opened before a person links them.';
COMMENT ON COLUMN d1_private.file_candidates.kind_confidence IS 'How sure the classifier is of kind, from 0 to 1 (three decimals); NULL when no classifier ran (documents, others). A surface scan is 1.0 (it is judged by its extension).';
COMMENT ON COLUMN d1_private.file_candidates.extracted IS 'What the classifier actually read from the file as a JSON object, for example {"kv": 15, "magnification": 5000, "instrument": "JEOL"}; only values that were read, never guesses. Empty object when nothing was read.';
COMMENT ON COLUMN d1_private.file_candidates.origin IS 'new: found after the owner''s first complete scan (counted as new in the Inbox). backlog: found during that first scan (shown as Older files, not counted as new, but flagged when it has an exact match).';
COMMENT ON COLUMN d1_private.file_candidates.state IS 'new: undecided. linked: a person linked it to a record (see the link_* columns). dismissed: a person dismissed it (undoable). gone: it vanished from the share before anyone decided; a hash-matched move re-points the row instead.';
COMMENT ON COLUMN d1_private.file_candidates.match_strength IS 'The strongest way the file''s relative path names a record: short_id (8 or more lowercase hex characters equal to a short ID), code (a full sample, operation or test code), edge_code (an insert edge code) or none. Two or more records at the strongest level are listed in matches and give no suggestion.';
COMMENT ON COLUMN d1_private.file_candidates.matches IS 'Every record the path names at the strongest level, as a JSON array of {collection, record_id, via, token}; empty array when none.';
COMMENT ON COLUMN d1_private.file_candidates.suggested_collection IS 'The collection of the single record the path names (physical_samples, manufacturing_operations, test_sessions, or insert_edges for an edge code); set together with suggested_record_id, only when exactly one record matches; else NULL.';
COMMENT ON COLUMN d1_private.file_candidates.suggested_record_id IS 'The id of the single record the path names; set together with suggested_collection, only when exactly one record matches; else NULL.';
COMMENT ON COLUMN d1_private.file_candidates.duplicate_of IS 'For an image or scan with the same content hash as an earlier candidate: that earlier candidate (where the file was first seen). The copy is shown as "copy of" and drops out when the original is linked or dismissed. NULL when not a duplicate or when the original row is gone (ON DELETE SET NULL).';
COMMENT ON COLUMN d1_private.file_candidates.rel_path IS 'The file''s path relative to the share root (star_group1), for example Users/abc12de/sem/3fa9c1d2.tif. Recognition reads this; the Inbox shows its folder part.';
COMMENT ON COLUMN d1_private.file_candidates.size_bytes IS 'File size in bytes when found; NULL when unknown.';
COMMENT ON COLUMN d1_private.file_candidates.source_mtime IS 'The file''s modification time on the share when found.';
COMMENT ON COLUMN d1_private.file_candidates.first_seen_at IS 'When the crawler first saw the file.';
COMMENT ON COLUMN d1_private.file_candidates.decided_at IS 'When a person linked or dismissed the file (or when it was linked automatically); NULL while undecided. Cleared by an undo or a restore.';
COMMENT ON COLUMN d1_private.file_candidates.decided_by IS 'The directus_users.id of the person who linked or dismissed it (the opted-in person for an auto-link); NULL while undecided or when that user was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN d1_private.file_candidates.link_kind IS 'How it was linked: manual (one file), bulk (Accept all or a batch of several) or auto (by the opted-in auto-link). The four link_* columns are all set when state is linked and all NULL otherwise (two CHECKs), so an undo must clear all four together with the state. Undo bookkeeping.';
COMMENT ON COLUMN d1_private.file_candidates.linked_collection IS 'The record collection it was linked to (physical_samples, manufacturing_operations or test_sessions); NULL unless state is linked. Undo bookkeeping.';
COMMENT ON COLUMN d1_private.file_candidates.linked_junction_id IS 'The id of the junction row the link created (sample_data_files, operation_data_files or session_data_files), so an undo removes exactly that row; NULL unless state is linked. Undo bookkeeping.';
COMMENT ON COLUMN d1_private.file_candidates.link_batch_id IS 'Shared by every file linked in one Link, Accept all or auto-link run; one Undo per batch removes exactly the junction rows of the batch. NULL unless state is linked.';
COMMENT ON COLUMN d1_private.file_candidates.adopted_at IS 'When a person linked a document or other non-image file: the signal for the crawler to read the file once, hash it and write file_fingerprints (open_rb with adopted=True). NULL for files never linked. Stays set after an undo, since the hash is wanted only once.';
COMMENT ON INDEX d1_private.file_candidates_pkey IS 'Primary key of the found file.';
COMMENT ON INDEX d1_private.file_candidates_directus_files_id_key IS 'One candidate per directus_files pointer row.';
COMMENT ON INDEX d1_private.idx_file_candidates_owner_person_state IS 'A person''s inbox tabs and counts: their candidates by state.';
COMMENT ON INDEX d1_private.idx_file_candidates_owner_team_state IS 'A team''s inbox tabs and counts: its candidates by state.';
COMMENT ON INDEX d1_private.idx_file_candidates_link_batch IS 'Undo: finds the candidates of one link batch. Partial: only linked rows have a batch.';
COMMENT ON INDEX d1_private.idx_file_candidates_suggested_record IS 'Finds the candidates that suggest a given record (for example to refresh them when a record is deleted). Partial: only rows with a suggestion.';
COMMENT ON INDEX d1_private.idx_file_candidates_duplicate_of IS 'Finds the copies of a candidate (when the original is linked, dismissed or deleted). Partial: only copies.';
COMMENT ON INDEX d1_private.idx_file_candidates_decided_by IS 'The foreign key to directus_users: finds what a user decided (the Recently linked and auto-linked lists), and keeps deleting a user cheap (ON DELETE SET NULL). Partial: only decided rows.';
COMMENT ON INDEX d1_private.idx_file_candidates_adopted IS 'The crawler''s hash-after-adoption loop: documents a person linked and that still need hashing. Partial: only adopted rows.';

-- 3. The folder cache.
CREATE TABLE d1_private.inbox_dirs (
    rel_path        TEXT        NOT NULL,
    owner_person_id UUID,
    owner_team_id   UUID,
    dir_mtime       TIMESTAMPTZ,
    last_listed_at  TIMESTAMPTZ,
    baselined_at    TIMESTAMPTZ,
    CONSTRAINT inbox_dirs_pkey PRIMARY KEY (rel_path),
    CONSTRAINT inbox_dirs_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT inbox_dirs_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES teams (team_id) ON DELETE CASCADE,
    CONSTRAINT inbox_dirs_one_owner_check CHECK (num_nonnulls(owner_person_id, owner_team_id) = 1)
);
CREATE INDEX idx_inbox_dirs_owner_person ON d1_private.inbox_dirs (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX idx_inbox_dirs_owner_team ON d1_private.inbox_dirs (owner_team_id) WHERE owner_team_id IS NOT NULL;

COMMENT ON TABLE d1_private.inbox_dirs IS 'The inbox crawler''s folder cache: one row per directory it has listed inside a person''s or a team''s folder, so the next scan stats each known directory (one cheap call) and lists only those whose modification time changed. Written only by the crawler (migration 193). Derived, recomputable: deleting rows only makes the next scan list those folders again. Folders that match nobody are not here: see inbox_crawler_state.unmatched_folders.';
COMMENT ON COLUMN d1_private.inbox_dirs.rel_path IS 'The directory''s path relative to the share root (star_group1), for example Users/abc12de or Users/abc12de/sem. An owner''s root row is their personal or team folder itself.';
COMMENT ON COLUMN d1_private.inbox_dirs.owner_person_id IS 'The person whose personal folder this directory is in, or NULL for a team directory; exactly one of owner_person_id and owner_team_id is set. Rows go with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_dirs.owner_team_id IS 'The team whose folder this directory is in, or NULL for a personal directory; exactly one of owner_person_id and owner_team_id is set. Rows go with the team (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_dirs.dir_mtime IS 'The directory''s modification time on the share when it was last listed; the next scan lists it again only when the share reports a different time.';
COMMENT ON COLUMN d1_private.inbox_dirs.last_listed_at IS 'When the crawler last listed this directory''s entries; NULL when it has been seen but not listed yet.';
COMMENT ON COLUMN d1_private.inbox_dirs.baselined_at IS 'Set on an owner''s root row when their first complete scan ends. Files first seen before it are origin backlog; files first seen after it are new. NULL until the first complete scan finishes.';
COMMENT ON INDEX d1_private.inbox_dirs_pkey IS 'One cache row per directory path.';
COMMENT ON INDEX d1_private.idx_inbox_dirs_owner_person IS 'All cached directories of one person (the scan of their folder, and the cascade when the person is deleted). Partial: only personal directories.';
COMMENT ON INDEX d1_private.idx_inbox_dirs_owner_team IS 'All cached directories of one team (the scan of its folder, and the cascade when the team is deleted). Partial: only team directories.';

-- 4. Scan requests.
CREATE TABLE d1_private.inbox_scan_requests (
    request_id   UUID        NOT NULL DEFAULT gen_random_uuid(),
    scope        TEXT        NOT NULL,
    person_id    UUID,
    requested_by UUID,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at   TIMESTAMPTZ,
    finished_at  TIMESTAMPTZ,
    status       TEXT        NOT NULL DEFAULT 'queued',
    error        TEXT,
    CONSTRAINT inbox_scan_requests_pkey PRIMARY KEY (request_id),
    CONSTRAINT inbox_scan_requests_person_id_fkey FOREIGN KEY (person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT inbox_scan_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES directus_users (id) ON DELETE SET NULL,
    CONSTRAINT inbox_scan_requests_scope_check CHECK (scope IN ('person', 'all')),
    CONSTRAINT inbox_scan_requests_status_check CHECK (status IN ('queued', 'running', 'done', 'failed')),
    CONSTRAINT inbox_scan_requests_scope_person_check CHECK ((scope = 'person') = (person_id IS NOT NULL))
);
CREATE INDEX idx_inbox_scan_requests_status ON d1_private.inbox_scan_requests (status, requested_at);
CREATE INDEX idx_inbox_scan_requests_person ON d1_private.inbox_scan_requests (person_id, requested_at DESC) WHERE person_id IS NOT NULL;
CREATE INDEX idx_inbox_scan_requests_requested_by ON d1_private.inbox_scan_requests (requested_by) WHERE requested_by IS NOT NULL;
-- At most one open request per person: the endpoint's "refused if one is queued" check is a read followed by an insert, so
-- two concurrent clicks could both pass it; this index makes the second insert fail (the endpoint turns that into a 429).
CREATE UNIQUE INDEX inbox_scan_requests_one_open_per_person_key ON d1_private.inbox_scan_requests (person_id)
    WHERE scope = 'person' AND status IN ('queued', 'running');

COMMENT ON TABLE d1_private.inbox_scan_requests IS 'The queue behind "Rescan my folder" (scope person) and the administrator''s "Scan all" (scope all), migration 193. The d1-inbox endpoint inserts a row (and refuses a person who has one queued or finished in the last 10 minutes); the crawler daemon claims queued rows about every 30 seconds with FOR UPDATE SKIP LOCKED, runs the scan and sets the status. Not audited: operational bookkeeping.';
COMMENT ON COLUMN d1_private.inbox_scan_requests.request_id IS 'Surrogate key of the request.';
COMMENT ON COLUMN d1_private.inbox_scan_requests.scope IS 'person: scan only the folder of person_id. all: scan every owner.';
COMMENT ON COLUMN d1_private.inbox_scan_requests.person_id IS 'The person whose folder to scan (scope person; required); NULL for scope all. Rows go with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_scan_requests.requested_by IS 'The directus_users.id who asked; NULL when that user was deleted (ON DELETE SET NULL).';
COMMENT ON COLUMN d1_private.inbox_scan_requests.requested_at IS 'When the request was queued. The per-person rate limit (10 minutes) is measured from here.';
COMMENT ON COLUMN d1_private.inbox_scan_requests.started_at IS 'When the daemon claimed the request and started scanning; NULL while queued.';
COMMENT ON COLUMN d1_private.inbox_scan_requests.finished_at IS 'When the scan for this request ended (done or failed); NULL until then.';
COMMENT ON COLUMN d1_private.inbox_scan_requests.status IS 'queued: waiting for the daemon. running: claimed, scanning. done: finished. failed: ended with an error (see error).';
COMMENT ON COLUMN d1_private.inbox_scan_requests.error IS 'Why a failed request failed (for example the share was unreachable); NULL otherwise.';
COMMENT ON INDEX d1_private.inbox_scan_requests_pkey IS 'One row per request.';
COMMENT ON INDEX d1_private.idx_inbox_scan_requests_status IS 'The daemon''s claim: queued requests, oldest first.';
COMMENT ON INDEX d1_private.idx_inbox_scan_requests_requested_by IS 'The foreign key to directus_users: keeps deleting a user cheap (ON DELETE SET NULL). Partial: only requests whose user is still known.';
COMMENT ON INDEX d1_private.inbox_scan_requests_one_open_per_person_key IS 'A person has at most one open (queued or running) person-scope request. Closes the race between the rate-limit read and the insert in the d1-inbox endpoint: the second of two concurrent requests fails with a unique violation, which the endpoint reports as 429. Partial: finished requests do not count.';
COMMENT ON INDEX d1_private.idx_inbox_scan_requests_person IS 'The per-person rate limit: a person''s latest request. Partial: only person-scope requests.';

-- 5. The crawler's control and status row.
CREATE TABLE d1_private.inbox_crawler_state (
    id                    UUID          NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
    desired_state         TEXT          NOT NULL DEFAULT 'running',
    interval_minutes      INTEGER       NOT NULL DEFAULT 30,
    read_mb_per_s         NUMERIC       NOT NULL DEFAULT 60,
    last_heartbeat_at     TIMESTAMPTZ,
    daemon_started_at     TIMESTAMPTZ,
    current_activity      TEXT,
    last_scan_started_at  TIMESTAMPTZ,
    last_scan_finished_at TIMESTAMPTZ,
    files_registered      BIGINT        NOT NULL DEFAULT 0,
    error_count           INTEGER       NOT NULL DEFAULT 0,
    last_error            TEXT,
    unmatched_folders     JSONB         NOT NULL DEFAULT '[]',
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT inbox_crawler_state_pkey PRIMARY KEY (id),
    CONSTRAINT inbox_crawler_state_singleton CHECK (id = '00000000-0000-0000-0000-000000000001'),
    CONSTRAINT inbox_crawler_state_desired_check CHECK (desired_state IN ('running', 'paused')),
    CONSTRAINT inbox_crawler_state_interval_check CHECK (interval_minutes >= 1),
    CONSTRAINT inbox_crawler_state_read_rate_check CHECK (read_mb_per_s > 0),
    CONSTRAINT inbox_crawler_state_unmatched_array_check CHECK (jsonb_typeof(unmatched_folders) = 'array')
);

INSERT INTO d1_private.inbox_crawler_state (id) VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE d1_private.inbox_crawler_state IS 'Singleton control and status row for the inbox crawler daemon (scripts/inbox_crawler/, compose service inbox-crawler), in the shape of force_crawler_state (migration 77), migration 193. An administrator sets desired_state, the interval and the read throttle through the d1-inbox admin routes; the daemon reads the row each loop and writes its heartbeat, activity and counters back so the admin tab can show it is alive.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.id IS 'Always 00000000-0000-0000-0000-000000000001: the table holds exactly one row (inbox_crawler_state_singleton).';
COMMENT ON COLUMN d1_private.inbox_crawler_state.desired_state IS 'running or paused: what the administrator wants. A paused daemon keeps its heartbeat but scans nothing. Default running.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.interval_minutes IS 'Minutes between scheduled scans of every owner''s folder. At least 1; default 30.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.read_mb_per_s IS 'Throttle on content hashing, in megabytes per second read from the share. Greater than 0; default 60.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.last_heartbeat_at IS 'Written by the daemon each loop; the admin tab shows the daemon as stopped when it is old. NULL before the first start.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.daemon_started_at IS 'When the running daemon process started.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.current_activity IS 'What the daemon is doing now, in words (for example "scanning Users/abc12de"); NULL when idle.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.last_scan_started_at IS 'When the latest scan began; NULL before the first scan.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.last_scan_finished_at IS 'When the latest scan ended normally; NULL before the first scan, and not advanced by an aborted scan (for example when the share disappeared).';
COMMENT ON COLUMN d1_private.inbox_crawler_state.files_registered IS 'How many found files the daemon has registered since this row was created.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.error_count IS 'How many errors the daemon has hit since this row was created.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.last_error IS 'The latest error message the daemon hit; NULL when there has been none.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.unmatched_folders IS 'JSON array of paths relative to the share root (for example "Users/zz9" or "Shared/Old project") of folders directly under Users/ and Shared/ that match no person''s uni alias and no team''s share folder. Rewritten by the crawler each scan; shown to administrators; those folders are not scanned.';
COMMENT ON COLUMN d1_private.inbox_crawler_state.updated_at IS 'When the row last changed. Set by the writer (endpoint or daemon).';
COMMENT ON INDEX d1_private.inbox_crawler_state_pkey IS 'The single state row.';

-- 6. The auto-link opt-in.
CREATE TABLE d1_private.inbox_prefs (
    user_id    UUID        NOT NULL,
    auto_link  BOOLEAN     NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT inbox_prefs_pkey PRIMARY KEY (user_id),
    CONSTRAINT inbox_prefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES directus_users (id) ON DELETE CASCADE
);

COMMENT ON TABLE d1_private.inbox_prefs IS 'Per-person Inbox preferences, today only the auto-link opt-in (migration 193; separate from user_prefs of migration 170, whose JSON is owned and validated by the d1-usage endpoint). Read and written by the d1-inbox endpoint for the caller''s own row, never through the items API (d1_private is outside the Directus schema scan). No audit trigger: updated_at records when the person last changed it.';
COMMENT ON COLUMN d1_private.inbox_prefs.user_id IS 'The directus_users.id these preferences belong to. The row goes with the user (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_prefs.auto_link IS 'True when this person agreed to auto-linking: files in their personal folder that name exactly one record by an exact short ID, that the person can edit, and that are images or surface scans (never documents) are linked for them after each scan, listed under Recently auto-linked, with an undo. Default false (off).';
COMMENT ON COLUMN d1_private.inbox_prefs.updated_at IS 'When auto_link last changed (the time of the consent). Set by the endpoint on write.';
COMMENT ON INDEX d1_private.inbox_prefs_pkey IS 'One preferences row per user.';

-- 7. A changed alias or share folder starts that owner's folder over.
-- The crawler's folder cache (inbox_dirs) and the undecided candidates describe the OLD folder. Left alone they would
-- strand: the cache says "already listed" for paths the new folder does not have, and new / gone / dismissed files of the
-- old folder would sit in the Inbox for a folder that is no longer theirs. So when the value really changes (IS DISTINCT
-- FROM, not on every UPDATE of the row) the owner's cache rows and their candidates in state new, gone or dismissed are
-- deleted; linked candidates are kept (the link is a decision and its undo bookkeeping must survive). The owner's next
-- scan is then a first scan of the new folder: everything in it is backlog, and baselined_at is set again.
CREATE FUNCTION d1_private.inbox_person_alias_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM d1_private.inbox_dirs WHERE owner_person_id = OLD.person_id;
    DELETE FROM d1_private.file_candidates
     WHERE owner_person_id = OLD.person_id AND state IN ('new', 'gone', 'dismissed');
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.inbox_person_alias_changed() IS 'Trigger function (migration 193): when a person''s uni_alias changes, deletes the old folder''s cache rows (inbox_dirs) and that person''s found files in state new, gone or dismissed; linked ones are kept. The next scan is a first scan of the new folder.';
CREATE TRIGGER people_inbox_alias_changed AFTER UPDATE OF uni_alias ON people
    FOR EACH ROW WHEN (OLD.uni_alias IS DISTINCT FROM NEW.uni_alias)
    EXECUTE FUNCTION d1_private.inbox_person_alias_changed();

CREATE FUNCTION d1_private.inbox_team_folder_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM d1_private.inbox_dirs WHERE owner_team_id = OLD.team_id;
    DELETE FROM d1_private.file_candidates
     WHERE owner_team_id = OLD.team_id AND state IN ('new', 'gone', 'dismissed');
    RETURN NULL;
END
$$;
COMMENT ON FUNCTION d1_private.inbox_team_folder_changed() IS 'Trigger function (migration 193): when a team''s share_folder changes, deletes the old folder''s cache rows (inbox_dirs) and that team''s found files in state new, gone or dismissed; linked ones are kept. The next scan is a first scan of the new folder.';
CREATE TRIGGER teams_inbox_folder_changed AFTER UPDATE OF share_folder ON teams
    FOR EACH ROW WHEN (OLD.share_folder IS DISTINCT FROM NEW.share_folder)
    EXECUTE FUNCTION d1_private.inbox_team_folder_changed();

-- migrate:down
SET LOCAL lock_timeout = '10s';
DROP TRIGGER IF EXISTS teams_inbox_folder_changed ON teams;
DROP TRIGGER IF EXISTS people_inbox_alias_changed ON people;
DROP FUNCTION IF EXISTS d1_private.inbox_team_folder_changed();
DROP FUNCTION IF EXISTS d1_private.inbox_person_alias_changed();
-- The five tables go with their rows (found files, folder cache, requests, state, opt-ins: all derived or recomputable;
-- a person's auto-link opt-in is lost, and they must agree again). A candidate's directus_files pointer row stays,
-- as it is an ordinary file row. The new people and teams columns go with their data (aliases and share folders are
-- lost: an administrator has to enter them again after an up).
DROP TABLE IF EXISTS d1_private.inbox_prefs;
DROP TABLE IF EXISTS d1_private.inbox_crawler_state;
DROP TABLE IF EXISTS d1_private.inbox_scan_requests;
DROP TABLE IF EXISTS d1_private.inbox_dirs;
DROP TABLE IF EXISTS d1_private.file_candidates;

DROP INDEX IF EXISTS teams_share_folder_key;
ALTER TABLE teams
    DROP CONSTRAINT IF EXISTS teams_share_folder_not_dots_check,
    DROP CONSTRAINT IF EXISTS teams_share_folder_trim_check,
    DROP CONSTRAINT IF EXISTS teams_share_folder_format_check,
    DROP COLUMN IF EXISTS share_folder;

DROP TRIGGER IF EXISTS people_inbox_columns_insert ON people;
DROP FUNCTION IF EXISTS d1_private.people_inbox_columns_insert_guard();
DROP INDEX IF EXISTS people_uni_alias_key;
ALTER TABLE people
    DROP CONSTRAINT IF EXISTS people_uni_alias_format_check,
    DROP COLUMN IF EXISTS scan_while_former,
    DROP COLUMN IF EXISTS uni_alias;
