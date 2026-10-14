# ADR-0019 — Operations and tests can be planned; samples an operation will make are planned samples

- **Status:** Proposed (2026-10-14)
- **Date:** 2026-10-14
- **Deciders:** Maintainer + Claude (process map edit mode interview,
  [spec](../superpowers/specs/2026-10-14-process-map-edit-mode-design.md))

## Context

The process map's edit mode lets someone lay out work before it is done: cut this disc into four, polish
each piece, test two of them. Until now every `manufacturing_operations` and `test_sessions` row meant
"this happened": operations have no state column at all, and `test_sessions.status` is the heavy-data
pipeline's state (registered → … → analysed, migration `20260619000013_status_vocabulary.sql`), not whether
the test was carried out. Labels are printed before cutting, and later steps are planned against pieces
that do not exist yet, so the plan has to be made of real records, not of a picture that only the person
who drew it can see.

## Decision

1. **A work state on operations and tests.** `manufacturing_operations.work_state` and
   `test_sessions.work_state`, `text NOT NULL DEFAULT 'done' CHECK (work_state IN ('planned', 'done'))`.
   The default keeps every existing writer (Data Studio forms, the FAST importer, the Force App) writing
   done records without a change. `test_sessions.status` keeps its pipeline meaning; a planned test simply
   has nothing to process yet.
2. **Planned and done dates are separate.** `planned_date date NULL` holds when the work is meant to happen.
   `operation_date` / `session_date` stay the date it happened and stay empty on a planned record.
   `done_by_person_id` (→ people) and `done_at timestamptz` record who marked it done and when.
3. **Planned samples.** `physical_samples.current_status` gains the value `planned`: a sample that a planned
   operation is going to make. It gets its code when it is created, so labels can be printed before the
   cut, and the code never changes afterwards (the code's date is the day it was planned).
4. **Mark done** is one action, done by the `d1-build` endpoint (ADR-0018) in one transaction: it sets
   `work_state = 'done'`, the date (default today), `done_by_person_id` and `done_at`, and turns the
   operation's planned output samples `active`. It refuses while the record's blocking checks are not met
   (the fields the form marks required for a done record).
5. **Back to planned is the owner's call.** Setting a done record back to planned is refused by
   `d1-access-guard` unless the caller owns the record (or manages its owning team) or is an admin. The
   audit log keeps both changes.
6. **Deleting planned work.** A planned operation or test may be deleted by its owner from the map; a
   planned operation's planned output samples go with it, unless something done already hangs off one of
   them, in which case the delete is refused. Done records are never deleted from the map.

## Alternatives considered

- **No state; a plan is a record without a date.** Rejected: "no date yet" and "not done yet" are different
  facts (old imports have no date and are done), and every reader would have to guess.
- **Reuse `test_sessions.status`.** Rejected: it is the processing pipeline's state, read by the workers;
  mixing "planned" into it would make them pick up tests that have no data.
- **Planned outputs created only at Mark done.** Rejected by the maintainer: labels could not be printed in
  advance, and later steps could not be planned against the pieces.
- **A boolean `is_planned`.** Rejected: a text state with a CHECK can grow (e.g. cancelled) without a
  second column, and reads the same in SQL and in Directus.
- **A separate plans table.** Rejected: two copies of every operation field, and a copy step at Mark done
  that loses the record's identity, code and access list.

## Consequences

- Anything that counts or reports "what was done" must now filter `work_state = 'done'` (reports, the
  campaign panels, dashboards, Ask-DB prompts). The process map draws planned containers and planned
  samples ghosted.
- Directus forms show the work state read-only; changing it goes through Mark done (or the owner's
  back-to-planned), so the date, the person and the outputs change together.
- Sample lifecycle readers (`current_status`) see a fourth live-ish value. A planned sample is not
  consumed, destroyed or archived; filters that mean "exists physically" must use `active`.
- Operation codes and test codes are assigned at insert as before, so a planned record has its final code.

## Verification

- Migration test: defaults, CHECKs, `planned` sample status, up/down/up.
- `d1-build` unit tests: Mark done turns outputs active; refuses with missing required fields; delete of a
  planned operation removes its planned outputs and refuses when something done hangs off them.
- `d1-access-guard` test: back-to-planned refused for a non-owner editor.

## References

- [ADR-0018](./0018-starbase-writes-records.md) (the `d1-build` endpoint), [ADR-0014](./0014-record-access.md)
  and [ADR-0016](./0016-teams.md) (owner and team managers), [ADR-0003](./0003-trigger-based-immutable-audit.md).
- Spec: `docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md`.
- Glossary: `CONTEXT.md` → **planned** / **done**, **planned sample**.
