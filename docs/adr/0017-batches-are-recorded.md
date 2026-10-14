# ADR-0017: Batches are recorded; probable batches are only shown

- **Status:** Proposed (2026-10-14)
- **Date:** 2026-10-14
- **Deciders:** Maintainer + Claude (Process map interview,
  [spec](../superpowers/specs/2026-10-14-process-map-design.md) §5.3, §9, D14, D27, D28)
- **Relates to:** [ADR-0014](./0014-record-access.md), whose ownership rules the permissions below
  follow.

Several samples are often processed together as one job: four quarters polished in one run, a tray
heat-treated, a build plate printed. Each sample still has its own operation or test row. Nothing
ties those rows together, so the Process map can only **guess** that they belong together (several
pieces cut from one sample on one day; several samples polished, heat-treated or built on one day
with the same method, machine and recipe). The guess is wrong often enough that it cannot be the
only source: it misses a job done over two days and joins two separate jobs done on one.

## Decision

1. **A batch is a recorded thing.** A `batches` table holds `batch_id`, `code`, `batch_date`,
   `notes` and `owner_person_id`. `manufacturing_operations.batch_id` and `test_sessions.batch_id`
   point at it. Both are **nullable** (Directus marks a NOT NULL column without a default as
   required, the `short_id` incident) and `ON DELETE SET NULL`, so deleting a batch leaves its
   operations and tests exactly as they were, unbatched.
2. **The code is generated, and can be typed.** `code` is `NOT NULL UNIQUE` and takes
   `'B-' || lpad(nextval('batches_code_seq')::text, 4, '0')` as a column default, so Directus does
   not treat it as required. A `BEFORE INSERT` trigger fills it when an insert sends `NULL` (or a
   blank) explicitly, which a default does not cover and the Directus form may do. Any other unique
   text is kept. `lpad` truncates, so the generated pattern is unique up to `B-9999`; beyond that a
   person types a code. A code typed by hand in the generated shape (`B-0007`) can later collide
   with the sequence, and the insert then fails on the unique constraint until the sequence passes it.
3. **The Process map draws recorded batches as batches, and guesses only the rest.** Rows with the
   same `batch_id` form one container, in every process category. Rows with a `batch_id` never join a
   probable batch. A **probable batch** (the §5.3 guess) is shown dashed, headed "probable batch",
   and is never stored. The "Probable batches" chip turns guessing off.
4. **The FAST press's "Batch" field is the powder batch.** `sintering_batch_number` is relabelled
   **Powder batch** in Directus, with help text saying it names a raw stock lot but is not linked
   to it. The word "batch" then means only several samples done together (`CONTEXT.md`). Matching
   powder-batch texts to stock lots is later work.
5. **Permissions.** A batch holds no sample data of its own, only a code, a date, notes and an
   owner, so it does not take part in the record-access machinery of ADR-0014 (no `restricted`, no
   access table, no readers table):
   - **Read: every Lab Member, all batches.** A batch reveals nothing the member could not already
     see on a record they may read; knowing that "B-0004" exists is harmless. The notes are readable by every member, so a private
     remark belongs on a restricted record, not in a batch. Whether a member can
     read the *operations* in it is still decided by those records' own rules. A batch is never
     used to widen access to an operation or a test.
   - **Create: every Lab Member.** The `d1-owner-default` hook (which `batches` joins) makes the
     creator the owner when the form leaves it blank.
   - **Update and delete: the owner or an admin.** Ownership is expressed as ADR-0014 expresses it:
     `owner_person_id.user_id` equals the signed-in user. Update and delete use the same filter, so
     nobody but the owner (or an admin) can do either.
   - Create and update are limited to `code, batch_date, notes, owner_person_id`; the system columns
     are admin-only. An owner may hand a batch to someone else, which only ever moves their own
     right to the new owner.
   - Attaching an operation or test to a batch is an update of *that record*, so it follows the
     record's own rules (`record.update`); owning the batch is not needed to put a record in it.
   The rows are the ones `scripts/access_rules.json` generates for `batches`
   (`gen_access_rules.py`, checked in CI by `access-rules-in-sync`); migration 177 embeds them.

## Considered options

- **Keep guessing only.** Rejected: it cannot represent a job the maintainer knows was one job, and
  its false groupings have no fix except to loosen the rule.
- **A `batch_id` on samples.** Rejected: the same sample goes through many jobs, and the batch is a
  property of the operation or test, not of the sample.
- **A free-text batch label on operations and tests.** Rejected: spelling drift, no place for a date
  or notes, nothing to open.
- **A junction table (`batch_operations`).** Rejected: an operation or a test is in at most one
  batch, so a nullable foreign key is the whole truth and is one less table to keep readable.
- **Run batches through ADR-0014 (restricted, access list, readers).** Rejected: a batch has no
  sample data to protect, and the machinery has real write cost (a global lock per refresh).
- **Owner-only read.** Rejected: a member must be able to pick any existing batch in the dropdown
  to add their operation to it, which needs read on the batch.

## Consequences

- **Deploy order.** Apply migration 177 first, then flush Redis and restart Directus (permissions
  and the new collection are cached; the owner-default hook is loaded at start), then deploy the
  STARbase build that groups by `batch_id`. A STARbase build that reads `batch_id` against a
  database without the column fails the request, so the page must not go first.
- **Down drops the recorded batches.** Rolling back removes the table and the foreign-key columns
  (operations and tests keep their rows) and restores the `sintering_batch_number` label to "Batch #".
- The Process map's grouping reads `batch_id`.
- The Ask-the-database role is not granted `batches` (ADR-0009); nothing needs it yet.
- Recorded batches do not retro-fit existing rows. Existing groups stay "probable" until someone
  records them.

## References

- Spec `docs/superpowers/specs/2026-10-14-process-map-design.md` §5.3, §9, D14, D27, D28.
- Migration `20261014000177_batches.sql`; `scripts/access_rules.json`, `scripts/gen_access_rules.py`;
  `core/extensions/d1-owner-default`; ADR-0014 (record access).
- `CONTEXT.md`: **Batch**, **Powder batch**, **FAST run**.
