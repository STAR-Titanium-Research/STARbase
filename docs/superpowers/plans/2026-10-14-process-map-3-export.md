# Process map — slice 3 (PNG/PDF export) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the whole Process map (current Show settings) as PNG or PDF, with a header (focus code and kind, date, who exported) and a legend of the kinds present.

**Architecture:** A pure `model/exportPlan.ts` decides the export frame (bounds of every drawn node, padding, pixel ratio clamped to the browser's canvas limit, page size and orientation, legend entries, header lines). `useMapExport.ts` renders an off-screen export frame around the Vue Flow viewport, captures it with `html-to-image`, and for PDF places the PNG on one landscape page with `jspdf`; both libraries load with dynamic `import()` on click. Downloads use a blob + temporary `<a download>` (never navigate).

**Tech Stack:** Vue 3.5, Vue Flow 1.48.2 (`getNodesBounds`, `getViewportForBounds`), `html-to-image` 1.11.13, `jspdf` 4.2.1, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-14-process-map-design.md` D26, §10.

## Global Constraints

- Worktree `D:\Users\CMBE Admn 3214022001\Documents\GitHub\D1-Database\.claude\worktrees\process-map`, branch `feat/process-map`.
- Exact versions in `packages/starbase-pages/package.json` dependencies: `html-to-image` `1.11.13`, `jspdf` `4.2.1`.
- Both libraries only via dynamic `import()` inside the export action (they must not enter the main chunk; check `apps/starbase/web` build output).
- STARbase CSP (apps/starbase/web/src/csp.ts and infra/caddy/Caddyfile) already allows `img-src 'self' data: blob:` and `font-src 'self' data:`; do not loosen it. STARbase loads no web fonts (Inter falls back to system fonts), so capture with `skipFonts: true`.
- Pixel ratio: 2, reduced so that `width × ratio` and `height × ratio` stay ≤ 16384 and their product ≤ 268,435,456 (browser canvas limits); never below 1 — if the map is still too big at ratio 1, export at ratio 1 and say "Large map: exported at screen resolution" in a notice.
- PDF: one landscape page; A4 (297×210 mm) unless the map's aspect ratio is wider than 2:1, then A3 (420×297 mm); the image fitted inside 10 mm margins, keeping aspect.
- File names: `process-map-<focus code>-<YYYY-MM-DD>.png|pdf` (focus code sanitised to `[A-Za-z0-9._-]`).
- Header text: "<Kind> <code> — Process map", "Exported <YYYY-MM-DD HH:mm> by <person name>". Legend: one swatch + kind label per kind present in the drawn nodes, in the KINDS order.
- No `window.open(`, `router.push(`, `'/assets/'` strings (hostNeutral guard); UI words per the glossary.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; push after each task; `py -m pre_commit run --files <changed>` before each commit.

## Review Focus

1. **A 300-card map** — the ratio clamp must keep the canvas inside browser limits (a blank PNG is the failure). → Task 1 test `clamps the pixel ratio for a huge map`.
2. **Export while a hover card or tooltip is open** — they must not appear in the export. → Task 1 (exclude `.pm-hover`, `.pm-tip`, controls, minimap, notices via the capture `filter`) + a unit test of the filter predicate.
3. **Export clicked twice quickly** — one export at a time; the button is disabled while running. → Task 1 test.
4. **Dark mode** — the export uses the page's current theme background (not transparent). → Task 1 (pass `backgroundColor` from the computed canvas background) + test of the option builder.
5. **Export failure** (library chunk fails to load, capture throws) — a visible error notice, the map untouched, the button re-enabled. → Task 1 test.

---

### Task 1: Export plan, composable and button

**Files:**
- Modify: `packages/starbase-pages/package.json`, `package-lock.json` (exact-version install)
- Create: `packages/starbase-pages/src/pages/map/model/exportPlan.ts` (+ `exportPlan.test.ts`)
- Create: `packages/starbase-pages/src/pages/map/useMapExport.ts` (+ `useMapExport.test.ts` with the libraries injected/faked)
- Create: `packages/starbase-pages/src/pages/map/ExportFrame.vue` (header + legend + slot, used only while exporting)
- Modify: `packages/starbase-pages/src/pages/map/ProcessMapPage.vue` (an "Export ▾" menu with PNG and PDF in the title actions next to Copy link)

**Interfaces:**
- Produces: `exportPlan(input: { bounds: { x: number; y: number; width: number; height: number }; kinds: Kind[]; focus: { kind: string; code: string }; person: string | null; now: Date; format: 'png' | 'pdf' }): { width: number; height: number; padding: number; pixelRatio: number; reduced: boolean; header: [string, string]; legend: { kind: Kind; label: string }[]; fileName: string; pdf?: { format: 'a4' | 'a3'; orientation: 'landscape'; imageBox: { x: number; y: number; w: number; h: number } } }`; `captureFilter(node: Element): boolean` (false for hover card, wire tip, Vue Flow controls, minimap, notices/banners).
- Produces: `useMapExport({ canvas, map }): { exporting: Ref<boolean>; error: Ref<string>; notice: Ref<string>; exportAs(format: 'png' | 'pdf'): Promise<void> }`.

- [ ] **Step 1:** Install `html-to-image@1.11.13` and `jspdf@4.2.1` with `--save-exact` into `@d1/starbase-pages`.
- [ ] **Step 2: Failing tests** (`exportPlan.test.ts`, `useMapExport.test.ts`): file name sanitising and date; header lines; legend only for kinds present, in KINDS order; ratio 2 for a normal map; `clamps the pixel ratio for a huge map` (e.g. 12000×9000 → ratio ≤ 16384/12000 and area within limit, `reduced` true when < 2); ratio floor 1 with the "Large map" notice; PDF A4 vs A3 at the 2:1 boundary and the image box inside 10 mm margins keeping aspect; `captureFilter` excludes the listed elements; `exportAs` while `exporting` is a no-op; a capture that throws sets `error` and resets `exporting`; the options passed to `toPng` include `skipFonts: true`, `pixelRatio`, `backgroundColor` and `filter`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. Capture approach: temporarily set the Vue Flow viewport transform with `getViewportForBounds(bounds, width, height, 0.1, 2, padding)` inside an off-screen `ExportFrame` sized to the plan, capture `.vue-flow__viewport` (+ frame header/legend), then restore the user's viewport; never leave the map moved. Download via blob URL + temporary anchor, revoke the URL after.
- [ ] **Step 5:** `npm test -w @d1/starbase-pages`, `npm test -w @d1/ui`, typecheck, `npm run build -w starbase-web` (confirm html-to-image and jspdf are in their own chunks) → PASS.
- [ ] **Step 6:** Commit `feat(map): export the process map as PNG or PDF`, push.

### Task 2: End-to-end export and docs

**Files:**
- Modify: `tests/ui/specs/19-process-map.spec.ts` (export scenario)
- Modify: `docs/wiki/database/explorer-pages.md` "Process map" section (export; also fix: probable batches are guessed for operations only, and say "the Show section")
- Modify: `docs/runbooks/starbase.md` batches section lead-in (the Batch field/collection need steps 1–2 only; step 3 is for the map)

- [ ] **Step 1:** Spec 17 scenario: open a sample's map, Export → PNG: wait for the `download` event, file name matches `^process-map-.+-\d{4}-\d{2}-\d{2}\.png$`, saved file > 10 KB and starts with the PNG signature; Export → PDF: name `.pdf`, starts with `%PDF`; the viewport transform after export equals the one before; no console errors (CSP violations would show here).
- [ ] **Step 2:** Run on a preview (`D1_PREVIEW_NAME=d1-starbase-map D1_PREVIEW_PORT=18059`, vite 5192) specs 13 + 17 `--retries=0` → PASS; stop the preview.
- [ ] **Step 3:** Docs edits; pre-commit.
- [ ] **Step 4:** Commit `test(map): export end to end; docs`, push.
