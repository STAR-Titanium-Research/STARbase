# Process map — slice 4 (card tweaks, stacks, reset and collapse) Implementation Plan

**Goal:** Feedback on the new container cards (2026-10-14), worked in one stream on `claude/jolly-fermi-us5mb7`.

**Files:** `packages/starbase-pages/src/pages/map/**`, `packages/d1-ui/src/components/PageShell.vue`.

**Tests:** `npm test -w @d1/starbase-pages`, `npm test -w @d1/ui`, `npm run typecheck -w @d1/starbase-pages`.

## Items

| # | Feedback | Change |
|---|---|---|
| 1 | No need for the "Inside" label | Label removed from the tray. |
| 2 | Show tools by name, not code | A slot shows the record's name (`label`) for tools and campaigns; the code stays in the hover card. |
| 3 | Force data preview only on the role label | The whole slot chip is the hover/click target, and a Force data slot's hover card carries the Fz figure. |
| 4 | Campaign, owner, material are not chips | Every slot is drawn as a chip; "more from the form" only hides them. |
| 5 | Operation name runs out of the title bar | Title bar says `<process> \| <method>` ("Machining \| Turning"); the full operation code and date are a wrapped line in the card. |
| 6 | Force plot preview tiny | Square figure, as wide as the card / rail allows. |
| 7 | Card, hover card and rail repeat each other | No hover card for a full container (the card already says it); the rail stays the full record. |
| 8 | No way to reset after ＋ | "Reset" in the panel: back to the map as first loaded, no request. |
| 9 | ＋ should become − | A card or slot that was expanded shows −; − removes what that expand added (cards, a used-in fan, a merged family). |
| 10 | Map should fill the screen | The page has no max width and the canvas fills the window height. |
| 11 | Many passes on one sample | Consecutive in-place operations on one sample with the same method and machine are stacked into one card (drawn as a deck); "Unstack" on the card, and a "Stack passes" Show chip. |

## Status

| Stream | Worktree | Branch | State |
|---|---|---|---|
| card tweaks (1-11) | — (main checkout) | `claude/jolly-fermi-us5mb7` | done, tests green; rig items PM4-1 to PM4-3 in the physical test backlog |
