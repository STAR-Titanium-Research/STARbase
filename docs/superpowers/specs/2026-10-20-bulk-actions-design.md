# Bulk actions on index pages — design

Date: 2026-10-20. Branch `feat/bulk-actions`. Status: written after the maintainer's design interview (all answers binding below).

## Why

An index page lists records but changes nothing; the only thing a ticked row can do today is "Print labels for selected" (samples). People who look after many records (a campaign's samples, a leaver's operations) must open each record to hand it to a team, change who can see it, or fix a field. This adds **bulk actions** to every index page, with a preview before applying, a short **undo**, and a **journal** an administrator can revert from.

## Decisions (maintainer, binding)

1. **Actions in v1, all of them:** assign to team, change owner (person), share or change access level, remove access, restrict or unrestrict, edit a field.
2. **General system:** works on any index page. A page opts into actions by its definition (`IndexDef`), not by code per page.
3. **Partial success:** apply what can be applied, skip the rest with a reason, one transaction per record.
4. **Emails:** one summary email per recipient per bulk action, never one per record.
5. **Selection reach:** the existing tick cap (`SELECT_MAX` = 100, kept across pages and filters); no "select everything matching the filter" in v1.
6. **UI:** one **With N selected ▾** menu replaces the "Print labels for selected" button (print labels becomes an entry in it). Each action opens a dialog that shows a dry-run preview, then confirms.
7. **Field edits:** each page declares a short `bulkFields` list. Kinds: choice, link, yes/no, date; plus "clear value". Free text is out of v1.
8. **Menu shows only what applies** to the page (ownership and access entries only on the four ownable record types; field edits only where `bulkFields` exists).
9. **Access actions:** *Share or change access* (adds the person or team, or updates their level), *Remove access*, and *Restrict or unrestrict* are three separate actions.
10. **Preview first:** the server answers a dry run per row without writing. The dialog shows counts ("38 can be changed, 12 skipped") and the skipped list with reasons.
11. **Undo:** the change commits immediately. An **Undo** toast with a **circular countdown** runs 60 seconds. Summary emails wait until the window closes; undo cancels them.
12. **Journal and revert:** every bulk action is journaled (who, when, action, rows, each row's before and after). An administrator can revert any bulk action later; the person who ran it can undo only inside the 60-second window. A revert skips any row changed since ("changed since") and is itself journaled as a bulk action linked to the original. A revert cannot be reverted; re-run the action instead.
13. **Visibility:** administrators see every bulk action on admin Home → "Bulk actions" with a Revert button; everyone else sees only their own, only as the live toast.
14. **Delivery:** stacked draft PRs, each shippable (section "Delivery").

## 1. What people see

- **Ticking everywhere.** Every index page shows the tick column. (Today only pages with a `selectAction` do.) The existing "Up to 100 rows" note stays.
- **Menu.** With nothing ticked the button reads "With selected ▾" and is disabled. With rows ticked: "With 4 selected ▾". Entries (only those that apply to the page): *Print labels* (samples, unchanged behaviour), *Assign to team…*, *Change owner…*, *Share or change access…*, *Remove access…*, *Restrict…* / *Unrestrict…*, and one *Edit <field>…* entry per `bulkFields` item.
- **Dialog.** Opens over the page like the Who-has-access dialog (backdrop, Esc, focus trap, focus returns to the menu button). Step 1: pick the target (a team via the existing team tiles, a person via `AccessPersonPicker`, an access level, a field value). Step 2 happens automatically: the dry run runs as soon as the target is chosen and the dialog shows *"38 can be changed. 12 will be skipped"* with an expandable list, each skipped row naming the reason in plain words ("You are not the owner", "That team has no manager yet", "Only administrators can restrict records yet"). Step 3: **Apply to 38** (disabled when 0).
- **Warnings the dry run carries** (Ruling O5): a transfer from a team to a person or another team does not keep the outgoing managers, so the acting manager may lose access to the record; the dialog says so before confirming. Undo/revert of such a transfer may be refused for the same reason (reported per row).
- **Result and toast.** On apply the dialog closes and a toast shows *"Assigned 38 samples to Team X"* (with "12 skipped" expandable), an **Undo** button and a circular countdown ring. Pressing Undo reverts and replaces the toast with *"Undone"* (with any "changed since" skips). When the ring ends the toast says *"Done"* and goes. Under `prefers-reduced-motion: reduce` the ring is static and the remaining seconds are shown as a number.
- **Admin Home → Bulk actions.** A panel listing recent bulk actions (when, who, action, collection, counts, state: applied / undone / reverted / partly reverted). Expanding one lists its rows. **Revert** (admin only) asks for confirmation and reports per-row outcomes.

## 2. Data model (migration 204, endpoint-only tables)

Both tables are read and written only by the new endpoint (as with the access tables); they are not registered in Directus.

```
bulk_actions(
  action_id uuid primary key default gen_random_uuid(),
  actor_user uuid not null,            -- directus_users.id
  actor_person uuid null,
  collection text not null,
  kind text not null,                  -- assign_team | change_owner | share_access | remove_access | restrict | unrestrict | edit_field
  params jsonb not null,               -- {team_id} | {person_id} | {person_id|team_id, role} | {field, value}
  created_at timestamptz not null default now(),
  undo_until timestamptz not null,     -- created_at + 60 s
  state text not null default 'applied',   -- applied | undone | reverted | partly_reverted
  revert_of uuid null references bulk_actions,
  mail_state text not null default 'pending',  -- pending | sent | cancelled | none
  mail_due_at timestamptz null,
  n_applied int, n_skipped int, n_failed int
)
bulk_action_rows(
  action_id uuid references bulk_actions on delete cascade,
  record_id text not null,
  record_code text,                    -- the label shown in lists
  outcome text not null,               -- applied | noop | skipped | failed
  reason text,
  before jsonb, after jsonb,           -- see "State snapshots"
  revert_outcome text null,            -- reverted | changed_since | refused | failed
  revert_reason text null,
  primary key (action_id, record_id)
)
```

Journal rows are append-only apart from `state`, `mail_state` and the `revert_*` columns. No retention limit in v1 (tiny rows).

### State snapshots

`before` and `after` hold only what the action can change, so "unchanged since" is a plain comparison:

- **Ownership / access / restrict actions:** `{ owner_person_id, owner_team_id, restricted, people: [{person_id, role}], teams: [{team_id, role, trust_new_members}] }`. `people` is the record's OWN person rows (`team_access_id IS NULL`); `teams` its team grants. Derived team rows, pending members and the database-held owner grant are never snapshotted (they are consequences, recomputed by the database triggers).
- **Field edits:** `{ <field>: <value> }`.

## 3. Server

### 3.1 Reuse, do not re-implement

`d1-record-access` is the ONLY writer of the access tables and holds the rules (can-manage, Ruling O3/O4/O5, legacy-table cleanup, readers triggers). The bulk code must call that logic, not copy it.

- Extract the in-transaction bodies of the existing routes (add person, change role, remove person, add team, change team, remove team, transfer) into functions `(trx, args, payload) -> { record, … }` created by a factory over the endpoint context, exported from `d1-record-access` (the file already exports shared helpers to `d1-teams` and `d1-access-guard`). The routes call them; behaviour and responses stay identical (existing tests must pass unchanged).
- Each function takes a `{ mail: false }` option or returns the data needed to mail later; the routes keep mailing exactly as today.

### 3.2 New endpoint `d1-bulk-actions` (core/extensions/d1-bulk-actions)

Mounted at `/d1-bulk-actions`. Same shape as `d1-teams` (`"directus:extension"` endpoint, `index.js` exporting `{ id, handler }`, `index.test.mjs` with a hand-built fake context). Same `route()` rules as `d1-record-access`: 401 without a user, 403 `READ_ONLY_ROLE` for Lab Viewer on any write (preview is a POST that writes nothing, but is refused for viewers too: there is nothing a viewer may preview), UUID and collection validation.

```
POST /d1-bulk-actions/:collection/preview   { kind, ids[], params }
  -> { results: [{ id, code, status: 'ok'|'noop'|'skip', reason?, warning? }], counts }
POST /d1-bulk-actions/:collection/apply     { kind, ids[], params }
  -> { action_id, undo_until, results: [{ id, code, outcome, reason? }], counts }
POST /d1-bulk-actions/:action_id/undo       -> { state, results: [{ id, revert_outcome, reason? }] }   (the actor, while now < undo_until; or an admin)
POST /d1-bulk-actions/:action_id/revert     -> same shape                                              (admin only, any time)
GET  /d1-bulk-actions                       -> { actions: [...] }   (admin: all; others: own; newest first, paged)
GET  /d1-bulk-actions/:action_id            -> { action, rows: [...] }  (same visibility)
```

Limits: `ids` ≤ 100, deduplicated; a kind not valid for the collection is 400 `NOT_APPLICABLE`.

**Per row, preview and apply run the same function**, preview in a transaction that is always rolled back (so preview and apply cannot disagree). Order per row: `requireReadable` (a row the caller cannot read is skipped as "not found", never revealed), then `requireManage` (skip "You are not the owner"), then the action's own rules (Ruling O3: team ownership only on the four ownable types; O4: no manager → skip; already owner → `noop`; Lab Viewer refused).

**Action implementations**

| kind | how | notes |
|---|---|---|
| `assign_team` | extracted transfer-to-team | skip when the collection is not ownable by a team or the team has no manager; previous person owner stays on as Can edit (Ruling O5) |
| `change_owner` | extracted transfer-to-person | skip if already the owner; the new owner's `blocked_by` is returned as a warning |
| `share_access` | extracted add or change (person or team) | upsert: add when absent, change level when present; `noop` if already that level |
| `remove_access` | extracted remove (person or team) | `noop` if not listed; refused for the owner (existing 409 TEAM_OWNS_RECORD / owner rules) |
| `restrict` / `unrestrict` | `ItemsService.updateOne({ restricted })` as the caller | d1-access-guard decides: today administrators only (`RESTRICT_ADMIN_ONLY`), later the owner. Its refusal text is the skip reason |
| `edit_field` | `ItemsService.updateOne({ [field]: value })` as the caller | the field must be in the page's `bulkFields` (the server keeps its own allow-list per collection, mirrored from the defs and checked against the field's kind); Directus permissions and d1-access-guard decide per row |

All knex writes use the existing `inTransaction` (sets `d1.actor_identity`, so `audit_logs` names the caller for every row). After commit: clear the data cache once for the whole action.

**Journal write.** `apply` inserts the `bulk_actions` row (with `undo_until = now + 60 s`, `mail_due_at = undo_until + 2 s`) and its `bulk_action_rows` in one transaction after the per-row work, with `before`/`after` captured inside each row's own transaction.

### 3.3 Undo and revert (one implementation)

`undo` and `revert` differ only in who may call and when. For each row with `outcome = applied`:

1. Load the row's **current** snapshot (same shape as `after`). If it is not equal to `after` → `revert_outcome = changed_since`, nothing written.
2. Otherwise compute the diff current → `before` and apply it with the extracted functions (`mail: false`): owner via transfer (person or team) — if Ruling O4/O5 makes it impossible (the old team now has no manager; the acting person cannot manage any more) → `refused` with the reason; access rows via add/change/remove; `restricted` and field values via `updateOne`.
3. Record `reverted` or `failed`.

The revert is journaled as a new `bulk_actions` row (`kind` = the original kind, `revert_of` = the original id, state `applied`, no mail). The original's `state` becomes `undone` (by the actor in-window), `reverted` (all rows reverted) or `partly_reverted`. A row already reverted is never reverted again; an action with `revert_of` set cannot be reverted (409).

### 3.4 Summary emails, held until the undo window closes

- At apply, `mail_state = 'pending'` (or `'none'` for kinds that mail nobody: remove access, restrict, edit field).
- A timer per action (`setTimeout` until `mail_due_at`) sends, then sets `mail_state = 'sent'`. On endpoint start a sweep sends every action with `mail_state = 'pending'` and `mail_due_at` past (a restart only delays mail; it never loses it). `undo` sets `mail_state = 'cancelled'` before the timer fires; the sender re-reads the state under a row lock so a race cannot both undo and send.
- **Content, built from the journal at send time** (recipients are looked up then, so a person removed in between is not mailed): to each new owner or team manager, one mail "N records were assigned to you / your team" listing codes (first 20, then "and N more") with links; to each person or team member given access, one mail "N records were shared with you (Can view|Can edit)"; the existing `mailContent`, `recipientAddress`, `withTimeout` and login-email-over-People-email rule are reused. A failed email is recorded (`mail_state = 'sent'` with a note in the log) and never undoes the change.
- An admin revert sends no email.

## 4. STARbase and kit (packages/d1-ui, packages/starbase-pages)

Pure logic in `packages/d1-ui/src/bulk/`, thin components next to it, no file over ~400 lines, no `@directus/extensions-sdk` imports.

- `indexConfig.ts`: `IndexDef` gains `bulkFields?: BulkField[]` (`{ field, label, kind: 'relation'|'enum'|'bool'|'date', relation?, values? }`, reusing the existing relation/enum option shapes) and `ownable?: true` on the four ownable defs (samples, operations, tests, campaigns). `selectAction` stays (print labels) and is rendered inside the menu.
- `bulk/bulkModel.ts` (pure): which entries a def offers, the dialog's wording ("Assign 38 samples to Team X"), grouping and wording of skip reasons, the countdown arithmetic (`secondsLeft(undoUntil, now)`), toast state machine (`pending → done | undone`).
- `bulk/bulkApi.ts`: `Outcome<T>`-style calls (never throw) for preview/apply/undo/revert/list.
- `bulk/useBulkActions.ts`: composable owning the dialog step, the preview request (stale answers dropped with `useRequestGate`), apply, and the active toast.
- Components: `BulkMenu.vue`, `BulkDialog.vue` (reusing `AccessPersonPicker`, `TeamTile`; same focus/Esc/backdrop conventions as `AccessDialog`), `UndoToast.vue` (SVG ring; `role="status" aria-live="polite"`; ring is static and a number under reduced motion; z-index band 1000, card style as `CreateToast`).
- `IndexPage.vue`: `ticks` becomes always true outside cards-only edge cases; the toolbar's single `selectAction` button is replaced by `BulkMenu`. After an apply or undo the list reloads and the selection clears (rows that were skipped stay ticked so the person can see them).
- Admin Home: `home/BulkActionsPanel.vue` in `AdminPanels.vue` (admin only; `isAdmin && adminKnown`), list + expand + **Revert** with a confirm.
- DESIGN.md: sentence case, British spelling, 11px floor, `--d1-*` tokens only, radii/shadows from the listed set, focus-visible rings, no raw hex; errors say what failed and what to do next. Menus appear without animation; the countdown ring is the only new motion and drops under `prefers-reduced-motion`.

## 5. Delivery (stacked draft PRs; each is shippable on its own)

| # | PR | Contents |
|---|---|---|
| 0 | spec + glossary | this document, `CONTEXT.md` terms |
| 1 | foundation | migration 204 (journal), extraction of `d1-record-access` bodies (no behaviour change), `d1-bulk-actions` skeleton (preview/apply/undo/revert/list plumbing, journal, mail timer + sweep, `edit_field` and `restrict`/`unrestrict` as the first kinds), kit: ticks everywhere, menu (with print labels), dialog, preview, toast with countdown, `bulkFields` on a first page |
| 2 | ownership | `assign_team`, `change_owner` (server + dialogs + warnings + summary mail) |
| 3 | access | `share_access`, `remove_access` |
| 4 | fields | `bulkFields` on all suitable index pages |
| 5 | admin | Bulk actions panel on admin Home with Revert |

Each PR runs the relevant tests (`node --test core/extensions/d1-bulk-actions/index*.test.mjs` plus d1-record-access; `npm test` and `typecheck` for `@d1/ui`, `@d1/starbase-pages`, `starbase-web`), adds a changelog-free note only where the repo convention requires, and lists what only live Directus can confirm in `docs/runbooks/physical-test-backlog.md`.

## 6. Testing

- **Server (node:test, fake context like d1-teams):** per-kind per-row outcomes (ok, noop, each skip reason); preview never writes; preview and apply agree; partial success; Lab Viewer refused; cap and dedupe; undo inside the window, refused after it for non-admins, allowed for admins; revert skips `changed_since`; revert of a revert refused; mail: pending → sent on timer, cancelled by undo, swept after restart, one mail per recipient, nobody mailed after a revert; extraction leaves `d1-record-access` tests green untouched.
- **Kit (vitest):** `bulkModel` (menu entries per def, wording, reasons, countdown, toast states), `bulkApi` Outcome mapping, `useBulkActions` (stale preview dropped, apply clears selection, undo flow), `indexConfig` (every ownable def flagged, `bulkFields` kinds valid), `IndexPage` (menu replaces the print button, print entry still routes to labels).
- **Live (physical-test backlog):** real Directus run of each action on a copy; undo email cancellation with a real mail transport; admin revert after a restart.

## 7. Risks and known gaps

- Ruling O5 means some ownership undos/reverts are refused (reported per row); the dialog warns up front.
- A restart inside the 60-second window loses the toast countdown's server timer only; the journal and sweep keep email correct. The toast itself lives on the index page: navigating away loses the button, and an administrator can still revert from admin Home.
- `restrict`/`unrestrict` are administrator-only until A1b opens `RESTRICT_ADMIN_ONLY`; the menu shows them and the preview explains.
- Field edits go through Directus as the caller one row at a time (≤ 100), so they are slower than a single batched update; accepted for exact per-row results.
- No bulk delete or archive (not requested).
- `selectionRoute` keys-in-URL cap (100) was the reason for `SELECT_MAX`; the bulk path posts ids in a body, but the cap stays as decided.

## 8. Files this touches

New: `core/extensions/d1-bulk-actions/*`, `db/migrations/20261020000204_bulk_actions.sql`, `packages/d1-ui/src/bulk/*`, `packages/starbase-pages/src/home/BulkActionsPanel.vue`.
Changed: `core/extensions/d1-record-access/index.js` (extraction only), `packages/d1-ui/src/index/{IndexPage.vue,IndexToolbar.vue,useRowSelection.ts,indexConfig.ts}` and tests, `packages/starbase-pages/src/home/AdminPanels.vue`, `CONTEXT.md`, `docs/runbooks/physical-test-backlog.md`.
