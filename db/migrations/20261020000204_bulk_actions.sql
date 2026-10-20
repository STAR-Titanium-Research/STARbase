-- migrate:up
-- Bulk actions (docs/superpowers/specs/2026-10-20-bulk-actions-design.md section 2): the journal of the actions people run on many
-- records at once from an index page (restrict, unrestrict, edit a field in this release; assign, change owner, share and remove
-- access in the next ones), with each record's before and after, so the person who ran one can undo it inside 60 seconds and an
-- administrator can revert it later.
--
--   * bulk_actions      one row per action (and one per revert, linked to the action it reverts by revert_of): who, when, on which
--                       collection, what kind, the parameters, the undo window, the state and the counts;
--   * bulk_action_rows  one row per record the action looked at: the outcome, the reason a record was skipped, and the snapshots
--                       `before` and `after` that undo and revert compare and restore.
--
-- Both tables are written and read ONLY by the d1-bulk-actions endpoint (like the readers and access tables): they are not
-- registered in Directus, no Directus permission is granted and they are not granted to the Ask-the-database role (d1_llm_readonly: the
-- snapshots hold record data, and default privileges no longer grant new tables to it since migration 132). Journal rows are
-- append-only apart from state, mail_state and the revert_* columns, so there is no OCC version and no audit trigger: the journal IS
-- the history, and each record's own change is still audited by its own table. actor_user and actor_person carry no foreign key on
-- purpose: the journal must outlive a login or a person that is deleted later.
-- Down: drops both tables (the journal is lost; nothing else refers to it).

CREATE TABLE bulk_actions (
    action_id UUID NOT NULL DEFAULT gen_random_uuid(),
    actor_user UUID NOT NULL,
    actor_person UUID,
    collection TEXT NOT NULL,
    kind TEXT NOT NULL,
    params JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    undo_until TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'applied',
    revert_of UUID,
    mail_state TEXT NOT NULL DEFAULT 'pending',
    mail_due_at TIMESTAMPTZ,
    n_applied INTEGER,
    n_skipped INTEGER,
    n_failed INTEGER,
    CONSTRAINT bulk_actions_pkey PRIMARY KEY (action_id),
    CONSTRAINT bulk_actions_kind_check CHECK (kind IN ('assign_team', 'change_owner', 'share_access', 'remove_access', 'restrict', 'unrestrict', 'edit_field')),
    CONSTRAINT bulk_actions_state_check CHECK (state IN ('applied', 'undone', 'reverted', 'partly_reverted')),
    CONSTRAINT bulk_actions_mail_state_check CHECK (mail_state IN ('pending', 'sent', 'cancelled', 'none')),
    CONSTRAINT bulk_actions_revert_of_fkey FOREIGN KEY (revert_of) REFERENCES bulk_actions (action_id)
);
CREATE INDEX idx_bulk_actions_created_at ON bulk_actions (created_at DESC);
CREATE INDEX idx_bulk_actions_actor_user ON bulk_actions (actor_user, created_at DESC);
CREATE INDEX idx_bulk_actions_revert_of ON bulk_actions (revert_of) WHERE revert_of IS NOT NULL;
CREATE INDEX idx_bulk_actions_mail_pending ON bulk_actions (mail_due_at) WHERE mail_state = 'pending';

CREATE TABLE bulk_action_rows (
    action_id UUID NOT NULL,
    record_id TEXT NOT NULL,
    record_code TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    before JSONB, -- noqa: RF04
    after JSONB, -- noqa: RF04
    revert_outcome TEXT,
    revert_reason TEXT,
    CONSTRAINT bulk_action_rows_pkey PRIMARY KEY (action_id, record_id),
    CONSTRAINT bulk_action_rows_action_id_fkey FOREIGN KEY (action_id) REFERENCES bulk_actions (action_id) ON DELETE CASCADE,
    CONSTRAINT bulk_action_rows_outcome_check CHECK (outcome IN ('applied', 'noop', 'skipped', 'failed')),
    CONSTRAINT bulk_action_rows_revert_outcome_check CHECK (revert_outcome IS NULL OR revert_outcome IN ('reverted', 'changed_since', 'refused', 'failed'))
);

COMMENT ON TABLE bulk_actions IS 'Journal of bulk actions run from an index page: one row per action, and one per revert (revert_of names the action it reverts). Written and read only by the d1-bulk-actions endpoint; not registered in Directus. Append-only apart from state, mail_state and the counts.';
COMMENT ON COLUMN bulk_actions.action_id IS 'Primary key.';
COMMENT ON COLUMN bulk_actions.actor_user IS 'The login (directus_users.id) that ran the action. No foreign key: the journal outlives a deleted login.';
COMMENT ON COLUMN bulk_actions.actor_person IS 'The People row of that login at the time, when it had one. No foreign key: the journal outlives a deleted person.';
COMMENT ON COLUMN bulk_actions.collection IS 'The collection the action ran on: physical_samples, manufacturing_operations, test_sessions, campaigns or projects.';
COMMENT ON COLUMN bulk_actions.kind IS 'What the action did: assign_team | change_owner | share_access | remove_access | restrict | unrestrict | edit_field. A revert carries the kind of the action it reverts.';
COMMENT ON COLUMN bulk_actions.params IS 'What the person chose: {team_id} | {person_id} | {person_id|team_id, role} | {field, value}. Empty object for restrict and unrestrict.';
COMMENT ON COLUMN bulk_actions.created_at IS 'When the action ran.';
COMMENT ON COLUMN bulk_actions.undo_until IS 'End of the undo window (created_at + 60 s): the person who ran the action can undo it until then; an administrator can revert at any time. For a revert it equals created_at (a revert cannot be undone).';
COMMENT ON COLUMN bulk_actions.state IS 'applied | undone (the actor undid it inside the window) | reverted (an administrator reverted every record) | partly_reverted (some records were changed since, or refused). A revert row itself stays applied.';
COMMENT ON COLUMN bulk_actions.revert_of IS 'The action this row reverts; NULL for an ordinary action. A row with revert_of set cannot be reverted again.';
COMMENT ON COLUMN bulk_actions.mail_state IS 'The summary email of ownership and access actions: pending (held until the undo window closes) | sent | cancelled (undone first) | none (this kind mails nobody, or it is a revert).';
COMMENT ON COLUMN bulk_actions.mail_due_at IS 'When the held summary email may be sent (undo_until + 2 s); NULL when mail_state is none.';
COMMENT ON COLUMN bulk_actions.n_applied IS 'How many records the action changed.';
COMMENT ON COLUMN bulk_actions.n_skipped IS 'How many records it skipped (not readable, not allowed, or already as asked).';
COMMENT ON COLUMN bulk_actions.n_failed IS 'How many records failed with an error other than a refusal.';

COMMENT ON TABLE bulk_action_rows IS 'One row per record a bulk action looked at: the outcome, why it was skipped, and the before and after snapshots that undo and revert use. Cascades with its action.';
COMMENT ON COLUMN bulk_action_rows.action_id IS 'The action (bulk_actions.action_id); part of the primary key.';
COMMENT ON COLUMN bulk_action_rows.record_id IS 'The record id as text (the key of the collection); part of the primary key.';
COMMENT ON COLUMN bulk_action_rows.record_code IS 'The label shown in lists (sample code, pass code, test code, campaign code or project code); NULL when the record could not be read, so a hidden record is never named.';
COMMENT ON COLUMN bulk_action_rows.outcome IS 'applied (changed) | noop (already as asked) | skipped (refused or not readable; see reason) | failed (an unexpected error).';
COMMENT ON COLUMN bulk_action_rows.reason IS 'Why the record was skipped or failed, in plain words.';
COMMENT ON COLUMN bulk_action_rows.before IS 'What the action could change, before it ran: {field: value} for a field edit, {restricted} for restrict and unrestrict, the owner/access shape for ownership and access actions.';
COMMENT ON COLUMN bulk_action_rows.after IS 'The same shape after the action ran. Undo and revert write before back only when the record still equals this.';
COMMENT ON COLUMN bulk_action_rows.revert_outcome IS 'What undo or revert did to this record: reverted | changed_since (the record differs from after, left alone) | refused (a rule forbids it now) | failed. NULL until undone or reverted.';
COMMENT ON COLUMN bulk_action_rows.revert_reason IS 'Why a record was not reverted, in plain words.';

-- migrate:down
DROP TABLE IF EXISTS bulk_action_rows;
DROP TABLE IF EXISTS bulk_actions;
