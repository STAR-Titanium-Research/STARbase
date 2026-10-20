# Plan: Project page hero

Spec: `docs/superpowers/specs/2026-10-20-project-page-hero-design.md`. Branch: `claude/compassionate-rubin-18pha4`.
Coordinator merges each stream branch after review. Workers commit after every step, never push, merge or rebase.
Commit trailer lines (both, at the end of every message):

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011vo4wDvALxCfZc4drFUZnP
```

## Status

| Stream | Worktree | Branch | Model | State |
|---|---|---|---|---|
| A: kit (timeline model + component, people stack, chart tokens, Sparkline) | agent worktree | hero-a-kit | Sonnet | planned |
| C: docs (DESIGN.md, backlog item) | agent worktree | hero-c-docs | Haiku | planned |
| B: Project page (data, hero, layout) | agent worktree | hero-b-page | Sonnet | waits for A |
| Simplify pass | main branch | — | coordinator | waits for B |
| Review | read-only | — | Opus (directus-ui-reviewer) | waits for simplify |

## Stream A: kit (`packages/d1-ui`)

Owns: `src/components/tokens.css`, `src/components/Sparkline.vue`, new `src/record/projectTimeline.ts` (+ test),
new `src/components/ProjectTimeline.vue`, new `src/access/peopleStack.ts` (+ test), new
`src/components/PeopleStack.vue`, `src/index.ts` exports.

1. Tokens `--d1-chart-1`, `--d1-chart-2` (light / dark per spec "Colours"); Sparkline uses them.
2. `projectTimeline.ts`: pure `projectTimeline(input) → model` (domain, project bar, campaign rows, undated
   codes, ISO weeks with ops/tests, planned markers, y ticks, x ticks, empty flag, last op/test). Reuse
   `activity.ts` week helpers. Tests: ranges (30 d, 6 mo, all), no end date, undated campaigns, empty, nice steps.
3. `ProjectTimeline.vue`: renders the model (spec "Timeline"), `range` v-model with a `SegmentedControl`,
   ResizeObserver width, tooltip, legend, sr-only table, one-line empty state. Theme variables only.
4. `peopleStack.ts`: from an `AccessList` (`access/accessModel.ts`) → ordered faces (owner/PI, investigators,
   edit, view; people and teams), `shown` (6), `fading` (≤ 3 with opacities), counts for the line. Tests.
5. `PeopleStack.vue`: renders it, emits `open` (the page opens `AccessDialog`).
Checks: `npm test -w @d1/ui && npm run typecheck -w @d1/ui`.

## Stream C: docs

Owns: `DESIGN.md`, `docs/runbooks/physical-test-backlog.md`.
1. `DESIGN.md`: `--d1-chart-1/2` move from Proposed into the tables; section 4 adds `ProjectTimeline` and
   `PeopleStack`; section 5 gets a "Project page hero" paragraph (spec "Layout" and its table) and notes that the
   Project page does not use `RecordLayout`.
2. Backlog: item **PP2** under "Explorer pages (STARbase)" (spec "Testing"; real Directus, light and dark,
   planned work, access list, empty range).

## Stream B: Project page (`packages/starbase-pages`), after A is merged

Owns: `src/pages/ProjectPage.vue`, `src/pages/projects/*`, and removal of now-unused
`projectRailFacts` / `projectContents` in `packages/d1-ui/src/record/projectFacts.ts` (+ tests, export) if
nothing else uses them.
1. `useProjectData`: done/planned counts, campaign status counts, activity over the whole range with planned
   dates, campaigns with dates, access list (`loadAccess`, fail-soft section).
2. `ProjectHero.vue` (head, people row, timeline, about, totals; container-query layout) and the page in the
   spec's order; `CampaignCards` raised on the ground with the fold; equipment tiles `--d1-tile`.
3. Range remembered in `localStorage` (try/catch).
Checks: the directus-ui-conventions list (`npm test -w @d1/ui`, typechecks, `npm run build:starbase`,
`npm run build:extensions`, `node --test core/extensions/*/index.test.mjs`).
