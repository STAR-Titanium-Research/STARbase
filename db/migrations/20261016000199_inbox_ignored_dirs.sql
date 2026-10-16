-- migrate:up
-- Ignored folders for the inbox crawler (stream IA of docs/superpowers/plans/2026-10-16-inbox-ignored-folders.md; spec section 15 of
-- docs/superpowers/specs/2026-10-15-found-files-inbox-design.md; decision context: ADR-0020).
--
-- Why: a person's or a team's folder on the lab share can hold large trees nobody wants in the Inbox (a finished project, a copy of a
-- downloaded dataset). "Ignore this folder when scanning" makes the crawler read LESS: it neither lists nor stats an ignored subtree, which
-- also lowers the load on the share. ADR-0020 stands: the crawler stays read-only, and a rule adds no share access.
--
-- One new table, d1_private.inbox_ignored_dirs, one row per rule. Like the other inbox tables (migration 193) it is in d1_private: outside the
-- Directus schema scan (never a collection), not in v_schema_dictionary, not granted to d1_llm_readonly, no audit or OCC triggers (a rule is
-- bookkeeping a person can add and remove again; what a rule changes, the dismissal of open candidates, is an ordinary restorable dismissal).
-- People reach it only through the d1-inbox endpoint (GET, POST, DELETE /ignored-folders); the crawler reads it (stream IB).
--
-- A rule belongs to the owner of the folder it sits under: a person for their own folder, a team for its team folder (the same two owner
-- columns, the same exactly-one CHECK and the same ON DELETE CASCADE as inbox_dirs). rel_folder is RELATIVE to the owner's root
-- ('World-Ti Paper/Drafts', not 'Users/abc12de/World-Ti Paper/Drafts'), so it does not depend on the alias or share folder spelling. (A change of
-- alias or share folder starts the owner's folder over, migration 193; the rules of the old folder are not wiped by that trigger and the endpoint
-- lists them as they are.) Matching (crawler and endpoint) is on whole path parts, case-insensitive, covering the folder and everything beneath
-- it; the share is case-insensitive, so the unique index is on lower(rel_folder).
--
-- The form of rel_folder is checked here, not only in the endpoint: no leading or trailing slash, no empty part, no '.' or '..' part (a '..'
-- would not be a folder at all; an empty rule would be the root, which cannot be ignored). At most 200 rules per owner is enforced in the
-- endpoint (under a lock), not here: a count limit in a CHECK would need a trigger for no gain.
--
-- created_by is a real foreign key to directus_users (ON DELETE SET NULL), as decided_by and requested_by are in migration 193: the rule
-- outlives the login that made it.
SET LOCAL lock_timeout = '10s';

CREATE TABLE d1_private.inbox_ignored_dirs (
    ignored_id      UUID        NOT NULL DEFAULT gen_random_uuid(),
    owner_person_id UUID,
    owner_team_id   UUID,
    rel_folder      TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID,
    CONSTRAINT inbox_ignored_dirs_pkey PRIMARY KEY (ignored_id),
    CONSTRAINT inbox_ignored_dirs_owner_person_id_fkey FOREIGN KEY (owner_person_id) REFERENCES people (person_id) ON DELETE CASCADE,
    CONSTRAINT inbox_ignored_dirs_owner_team_id_fkey FOREIGN KEY (owner_team_id) REFERENCES teams (team_id) ON DELETE CASCADE,
    CONSTRAINT inbox_ignored_dirs_created_by_fkey FOREIGN KEY (created_by) REFERENCES directus_users (id) ON DELETE SET NULL,
    CONSTRAINT inbox_ignored_dirs_one_owner_check CHECK (num_nonnulls(owner_person_id, owner_team_id) = 1),
    CONSTRAINT inbox_ignored_dirs_rel_folder_form_check CHECK (rel_folder <> '' AND rel_folder !~ '^/' AND rel_folder !~ '/$' AND rel_folder !~ '//'),
    CONSTRAINT inbox_ignored_dirs_rel_folder_parts_check CHECK (('/' || rel_folder || '/') !~ '/[.]{1,2}/')
);
-- One rule per owner and folder, ignoring case. coalesce(person, team) is the owner's id whichever kind it is (the CHECK above makes exactly one set).
CREATE UNIQUE INDEX inbox_ignored_dirs_owner_folder_key ON d1_private.inbox_ignored_dirs (coalesce(owner_person_id, owner_team_id), lower(rel_folder));
CREATE INDEX idx_inbox_ignored_dirs_owner_person ON d1_private.inbox_ignored_dirs (owner_person_id) WHERE owner_person_id IS NOT NULL;
CREATE INDEX idx_inbox_ignored_dirs_owner_team ON d1_private.inbox_ignored_dirs (owner_team_id) WHERE owner_team_id IS NOT NULL;
CREATE INDEX idx_inbox_ignored_dirs_created_by ON d1_private.inbox_ignored_dirs (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE d1_private.inbox_ignored_dirs IS 'Folders the inbox crawler must leave alone (migration 199, spec section 15 of the found files inbox design): one row per rule, owned by a person (their personal folder) or a team (its team folder). The crawler neither lists nor stats an ignored subtree and never marks a file under it gone; adding a rule dismisses the owner''s open found files under it (a restorable dismissal), removing one clears the folder cache so the next scan lists it again. Written only by the d1-inbox endpoint, read by the crawler. Not exposed in Directus, no audit or OCC triggers.';
COMMENT ON COLUMN d1_private.inbox_ignored_dirs.ignored_id IS 'Surrogate key of the rule.';
COMMENT ON COLUMN d1_private.inbox_ignored_dirs.owner_person_id IS 'The person whose personal folder the rule sits under, or NULL for a team rule; exactly one of owner_person_id and owner_team_id is set. Rules go with the person (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_ignored_dirs.owner_team_id IS 'The team whose folder the rule sits under, or NULL for a personal rule; exactly one of owner_person_id and owner_team_id is set. Rules go with the team (ON DELETE CASCADE).';
COMMENT ON COLUMN d1_private.inbox_ignored_dirs.rel_folder IS 'The ignored folder, relative to the owner''s root (for example World-Ti Paper/Drafts for Users/<alias>/World-Ti Paper/Drafts). Matched on whole path parts, ignoring case, and covers the folder itself and everything beneath it (World-Ti Paper does not cover World-Ti Paper 2). No leading or trailing slash, no empty, . or .. part, never the root itself; no wildcards.';
COMMENT ON COLUMN d1_private.inbox_ignored_dirs.created_at IS 'When the rule was added.';
COMMENT ON COLUMN d1_private.inbox_ignored_dirs.created_by IS 'The Directus user who added the rule; NULL once that user is deleted (ON DELETE SET NULL).';
COMMENT ON INDEX d1_private.inbox_ignored_dirs_pkey IS 'One row per rule.';
COMMENT ON INDEX d1_private.inbox_ignored_dirs_owner_folder_key IS 'One rule per owner and folder, ignoring case (the share is case-insensitive). The owner is the person or the team, whichever is set.';
COMMENT ON INDEX d1_private.idx_inbox_ignored_dirs_owner_person IS 'All rules of one person (the crawler loads them once per scan, and the cascade when the person is deleted). Partial: only personal rules.';
COMMENT ON INDEX d1_private.idx_inbox_ignored_dirs_owner_team IS 'All rules of one team (the crawler loads them once per scan, and the cascade when the team is deleted). Partial: only team rules.';
COMMENT ON INDEX d1_private.idx_inbox_ignored_dirs_created_by IS 'Rules made by one Directus user (the foreign key). Partial: only rules whose user still exists.';

-- migrate:down
SET LOCAL lock_timeout = '10s';
-- The rules go with the table: they are a person's preference and nothing else refers to them. After a down the crawler scans every folder again
-- and files dismissed by a rule stay dismissed until restored by hand, exactly as when a rule is removed.
DROP TABLE IF EXISTS d1_private.inbox_ignored_dirs;
