---
name: directus-ui-conventions
description: Background knowledge for any change to the custom Directus front end — the Explorer pages and Home (core/extensions/d1-home), the shared @d1/ui kit (packages/d1-ui), and the extensions that use it (d1-lab-dashboard, d1-campaign-ops, d1-project-items, d1-composition-bar, d1-fast-dashboard). Load before editing or reviewing files there. It lists the invariants that recent bugs came from.
user-invocable: false
paths:
  - packages/d1-ui/**
  - core/extensions/d1-home/**
  - core/extensions/d1-lab-dashboard/**
  - core/extensions/d1-campaign-ops/**
  - core/extensions/d1-project-items/**
  - core/extensions/d1-composition-bar/**
  - core/extensions/d1-fast-dashboard/**
---

# Directus front end: what to know before changing it

The design is [`docs/superpowers/specs/2026-10-06-explorer-pages-design.md`](../../../docs/superpowers/specs/2026-10-06-explorer-pages-design.md).
Who may see what is [ADR-0011](../../../docs/adr/0011-row-level-visibility.md). The Sample page
(`core/extensions/d1-home/src/pages/SamplePage.vue`, `pages/sample/*`) is the reference page:
copy its structure.

## Invariants

1. **Read as the signed-in user.** Every read goes through `/items` with `useApi()` (or the kit's
   `useItems`), so Directus permissions decide what is shown. No new endpoint that reads with the
   root knex. If SQL functions are unavoidable, follow `d1-trace`: find ids in SQL, then re-read
   every record through `ItemsService` with `req.accountability`.
2. **Never guess a column.** Confirm every field in `db/migrations/` or
   `scripts/configure_directus.sql` before using it. Traps:
   - `physical_samples.co_owners` is both a legacy TEXT column and the M2M alias over
     `sample_co_owners`. Read `co_owners.user_id.first_name` and similar, never bare `co_owners`.
   - Ownership is `owner_person_id` → `people`, and `people.user_id` is the login. The older
     `owner` / `principal_investigator` UUID columns are hidden backups.
   - Project investigators are the M2M alias `secondary_investigators` (`user_id`).
3. **One link mapping.** Every record link uses `recordRoute()` / `RecordLink` from `@d1/ui`.
   "Open in Data Studio" uses `dataStudioRoute()`. Never hand-write `/content/...` in a page.
4. **Not found and forbidden look the same.** A missing or unreadable root record shows "Not found
   or not visible to you". Each related section loads on its own, with its own error, so one
   forbidden list does not blank the page.
5. **Drop stale answers.** Use the kit's `useRequestGate` (latest request wins) for anything keyed
   by a route param.
   Load related blocks with the kit's `useSections(gate)` and `LIST_CAP`: a failed reload keeps the
   section's last data and shows the error. Do not copy a local `fill` helper.
6. **Edit through `EditDrawer`.** It renders the collection's own `v-form`, so custom interfaces
   keep working. Do not rebuild create or edit forms. "New" opens `/content/<c>/+`.
7. **Theme variables only** (`--theme--*`), so light and dark both work. Status colours and labels
   come from the kit's `status.ts`. Charts follow the `dataviz` skill.
8. **Pure logic lives in `packages/d1-ui` with vitest tests.** Components stay thin. No file over
   about 400 lines: split it.
9. **Workspaces.** Extensions that import `@d1/ui` are root npm workspaces with **no lock file of
   their own**:
   - add them to root `package.json` `workspaces` and `build:extensions`;
   - delete their `package-lock.json`;
   - run `npm ci` at the root.

   `d1-report` and the other extensions are not workspaces: build those in their own folder.
10. **Geometry has one engine.** `geometry.ts` copies are kept identical by
    `scripts/sync_geometry.sh`. Never add a copy; import d1-home's.
11. **Live checks go in the backlog.** Anything only a real Directus can confirm goes into
    `docs/runbooks/physical-test-backlog.md`, under "Explorer pages (Home module)", in the same
    change (see `CLAUDE.md`).

12. **One "belongs to project" rule.** Nothing in the database copies a campaign's project onto its
    operations, tests or samples. Read project-scoped records with the kit's `projectScopeFilter` /
    `sampleProjectScopeFilter` / `anyProjectFilter` (own `project_id`, else the campaign's), never a
    bare `project_id = P`. Pickers that put a record in a campaign set its `project_id` only where
    it is null (`campaign/assign.ts`).

## Checks before a commit

```bash
npm ci                                  # when workspaces or dependencies changed
npm test -w @d1/ui && npm run typecheck -w @d1/ui
npm run typecheck -w directus-extension-d1-home -w directus-extension-d1-campaign-ops
npm run build:extensions                # every workspace extension that uses the kit
node --test core/extensions/*/index.test.mjs
bash scripts/sync_geometry.sh --check
```

`d1-lab-dashboard` has no typecheck script (older cytoscape type errors in `NodeGraph.vue`).

Plus `npm run build:extension` and `npm test -w @d1/force-plotting` if you touched the force
dashboard host, and `npm ci && npm test` in `core/extensions/d1-report` if you touched it.

A headless render against a stubbed `/items` (Playwright and Chromium are preinstalled in cloud
sessions; never run `playwright install`) is the only way to see a page without Directus. Keep the
harness out of the repo.
