# T0c: the Force dashboard stops writing operation codes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After T0b the database owns operation codes; the Force dashboard (shared by the Directus
module `d1-force-dashboard` and the standalone Force App, both built from `packages/force-plotting`)
must stop composing and writing `pass_code`, and must show the code the database built.

**Architecture:** Remove the browser copy of the rule (`computeAutoCode`) from `packages/force-plotting`;
the metadata save no longer sends `pass_code`, the save reads the stored code back from the PATCH
response; the opt-in "Name vs fields" doctor check goes (it compared stored codes with the browser
rule, and typed codes are now intended). The Directus module is rebuilt and deployed together with
T0b; the standalone Force App gets it at its next release (a PR to `main` — the maintainer's call).

**Tech Stack:** Vue 3, TypeScript, Vitest (`npm test -w packages/force-plotting`), Directus REST.

**Spec:** [`docs/superpowers/specs/2026-10-10-record-codes-design.md`](../specs/2026-10-10-record-codes-design.md) §5
("Force dashboard … `computeAutoCode` is removed … no longer PATCHes `pass_code`"). Stage **T0c**.

## Global Constraints

- Worktree `.claude/worktrees/t0-record-codes`, branch `feat/record-codes`; never the main checkout
  or live; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- The dashboard never writes `pass_code`. Every other field save stays exactly as today.
- Operation-code display: the stored `pass_code`; after a save that changed a code input, the code
  shown is the one the database stored (read back from the PATCH response with
  `?fields=pass_code`).

## Decisions where the spec was silent

1. **The "Name vs fields" (`name.stale`) doctor check is removed**, not rewired to the preview
   endpoint: it is opt-in, it would flag every typed or legacy code (now intended), and an
   automatic code cannot be stale any more.
2. **No live code preview inside the dashboard**: the code box shows the stored code with the
   hint "Built by the database from the fields; updates when you save." (the Directus form has the
   live preview; YAGNI here).

---

### Task 1: Remove the browser rule from the dashboard

**Files:**
- Delete: `packages/force-plotting/src/operationCode.ts`, `packages/force-plotting/src/operationCode.test.ts`
- Modify: `packages/force-plotting/src/ForceDashboard.vue` (import line ~28; the comment block
  ~1427-1438; `regeneratedPassCode` ~1493-1511 deleted; `metaDirty` ~1512-1523 loses its last
  clause; `buildMetaPatch` ~1778 loses the `pass_code` line; `changeSummary` ~1804-1806 loses the
  "Operation code" row; `saveChanges` ~1810-1816 reads the code back; the "Operation code" input
  ~2661-2663 shows `srcMeta.passCode` with the new title; comments that refer to
  `regeneratedPassCode` / `computeAutoCode` (e.g. ~1239-1243, 1349-1350, 1467, 1551-1554, 1565,
  2626) updated or removed; the fields fetched only for `computeAutoCode` at ~1349 may stay if
  something else uses them, else drop them)
- Modify: `packages/force-plotting/src/metadataDoctor.ts` (remove the `computeAutoCode` import and
  the `name.stale` block ~197-220; update the header comment ~7 and the `optional` doc ~122) and
  `metadataDoctor.test.ts` (remove/adjust `name.stale` tests; keep the rest)
- Modify: `ForceDashboard.vue` ~1243: remove `{ id: 'name.stale', label: 'Name vs fields' }` from
  the optional-checks list.

- [ ] **Step 1: Tests first.** In `metadataDoctor.test.ts`, replace the `name.stale` tests with one
  asserting that asking for `name.stale` yields no finding of that id (the option is ignored). Run
  `npm test -w packages/force-plotting` → that test FAILS (the check still exists).
- [ ] **Step 2: Implement** the deletions/edits above. In `saveChanges`:

```ts
const patch = buildMetaPatch();
if (Object.keys(patch).length) {
	const { data } = await api.patch(`/items/manufacturing_operations/${o.operation_id}`, patch, {
		params: { fields: ['pass_code'] },
	});
	Object.assign(o, patch);                                  // optimistic update of the edited fields
	if (data?.data && 'pass_code' in data.data) o.pass_code = data.data.pass_code;  // the code the database built
	seedMetaFromDetail();
}
```

  (keep the existing error handling around it; if the PATCH response has no data — e.g. a 204 when
  the user may no longer read the row — keep the old code shown.)
- [ ] **Step 3: Verify.** `npm test -w packages/force-plotting` (all pass), `npm run typecheck -w packages/force-plotting`
  if it passed before your change (compare with a run on the base commit; report pre-existing
  errors without fixing unrelated ones), `npm run build -w directus-extension-d1-force-dashboard`
  (succeeds), and the Force App web build/test the repo uses (`npm test -w apps/force-app/web` and
  its build script — read `apps/force-app/web/package.json`) must still pass. `grep -rn
  "computeAutoCode\|regeneratedPassCode\|name.stale" packages apps core/extensions --include=*.ts --include=*.vue`
  (excluding node_modules/dist) → no hits.
- [ ] **Step 4: Commit** (`feat(force-plotting): the database owns operation codes; the dashboard no longer writes them`).

### Task 2 (coordinator): deploy with T0b

T0b's Task 9 runbook, with the `d1-force-dashboard` extension rebuilt from this branch's
`packages/force-plotting` in the main checkout and deployed in the same window. The standalone
Force App release (a PR to `main`, see `.claude/skills/force-app-release`) is the maintainer's
decision; until then it behaves as before T0b (it writes the code it composes; not a regression).
