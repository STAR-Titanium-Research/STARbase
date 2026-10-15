# ADR-0018 — STARbase writes records on the process map: its own generated form and one transactional create endpoint

- **Status:** Proposed (2026-10-14)
- **Date:** 2026-10-14
- **Deciders:** Maintainer + Claude (process map edit mode interview,
  [spec](../superpowers/specs/2026-10-14-process-map-edit-mode-design.md))
- **Amends:** [ADR-0015](./0015-directus-headless-starbase-is-the-only-front-end.md). STARbase no longer only
  reads: on the process map it creates and edits records with its own form.

## Context

ADR-0015 made STARbase the only front end, but left creating and editing to Data Studio's form, framed by
STARbase (`core/extensions/d1-edit-frame`). The process map's edit mode builds several records at once — new
samples, the operations between them, their tests, a batch — wired to each other by ids that do not exist until
the records are created. The framed form edits one record at a time, cannot be prefilled, and does not hand the
new id back (`apps/starbase/web/src/editor/editor.ts`). Directus's REST API cannot write several collections
in one transaction, and the genealogy trigger (`mfg_op_genealogy`) never removes a link it wrote, so a
half-finished sequence of single writes leaves wrong lineage behind. Directus 11 also does not enforce a
field's `required` flag on API saves, so whatever writes must check it.

## Decision

1. **One endpoint, `d1-build`, writes a whole draft in one database transaction** (all or nothing). It checks
   as the caller and writes through Directus's `ItemsService` with the caller's accountability and the
   transaction's knex (`knex: trx`), so Directus permissions and every hook (`d1-owner-default`,
   `d1-access-guard`, the inherit hooks) apply exactly as for a form save. Codes come from the existing
   triggers. It also does **Mark done** (ADR-0019) and keeps drafts and templates.
2. **Drafts and templates live in `d1_private`** (`process_drafts`, `process_templates`), reachable only
   through `d1-build`, like pins in `d1-usage`. A draft is private to its owner; templates use the saved views'
   three scopes (private, account role, everyone).
3. **STARbase gets its own form, generated from the Directus field definitions** (`/fields/<collection>`:
   groups, conditions, required flags, choices, labels, notes), so there is one source of truth for what a form
   contains. A field it cannot draw links to Data Studio. In v1 it is used **only in the process map's edit
   mode**; record pages keep the framed Data Studio form.
4. **Edits to existing records carry their version** and are refused on a mismatch (the OCC convention of
   `useEditSession`).

## Alternatives considered

- **Keep Data Studio's framed form for every field** (the interview's option a). Rejected by the maintainer:
  filling in a container should happen in the container, and the frame cannot be prefilled or report new ids.
- **Write record by record from the browser through the REST API.** Rejected: a failure halfway leaves
  operations without their outputs and lineage rows that nothing removes.
- **Write as the system with knex and re-implement permission checks.** Rejected: the hooks (owner default,
  access guard, inherit) and Directus's own rules would have to be duplicated and kept in step.
- **A hand-built STARbase form per process category.** Rejected: it would drift from the Data Studio form,
  whose field groups and conditions are already maintained in migrations (173–175).
- **Drafts in a Directus collection.** Rejected: drafts are private scratch state; a `d1_private` table needs
  no permissions, no audit and no Data Studio exposure.

## Consequences

- STARbase now has a write path of its own. Its form must follow the field metadata; a change to a field's
  interface that the generated form cannot draw degrades to "Open in Data Studio", not to a broken form.
- `d1-build` is the only place that creates several records together; other features that need that should
  reuse it rather than add another multi-write path.
- Directus's `required` flag becomes enforced for records made on the map (checked by `d1-build`), which it
  is not for API saves elsewhere.
- Deploy order: d1-server (migrations and `d1-build`) before STARbase. STARbase hides edit mode when
  `d1-build` is absent.

## Verification

- `node --test core/extensions/d1-build/index.test.mjs`: rollback on a failing write, ordering, OCC, draft
  ownership, template scopes.
- `packages/d1-ui` unit tests for the field model and the conditions evaluator.
- Physical test backlog (A): a lab member creates a cut with planned outputs; a refused record rolls the whole
  create back.

## References

- [ADR-0015](./0015-directus-headless-starbase-is-the-only-front-end.md), [ADR-0019](./0019-operations-and-tests-can-be-planned.md),
  [ADR-0017](./0017-batches-are-recorded.md), [ADR-0014](./0014-record-access.md).
- Spec: `docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md`.
- Precedents: `core/extensions/d1-people-admin/index.js` (Directus service inside a transaction),
  `core/extensions/d1-usage` (`d1_private` store), `core/extensions/d1-record-access` (check as caller, write in
  one transaction).
