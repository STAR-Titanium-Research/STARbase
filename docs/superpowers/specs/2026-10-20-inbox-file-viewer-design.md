# Inbox file viewer (sheet, view box, compare)

Status: agreed with the maintainer 2026-10-20 (grilling session). Mock-ups: the three pages `/view`, `/list`, `/alt` of the session's scratch server
(placeholder pictures); the decisions below are the contract. Look and tokens: `DESIGN.md` (sections 2 to 6, the View rail in 4 and 5).

## Goal

Today a click on an Inbox thumbnail opens `PreviewDialog.vue`: one picture and a block of text. People triage thousands of found files, many of them
SEM images, and want (1) to look at a picture without losing their place in the list, (2) a full view of one file with its facts, and (3) to put two
files side by side and measure on them.

## Decisions

1. **Largest picture: the stored preview** (about 1600 px on the long side, `d1_private.file_thumbnails.preview`, served by `GET /d1-inbox/files/:id/preview`).
   The originals sit on a read-only share and Directus does not serve them. No full-size streaming endpoint now. Measure scales by
   `original width / preview width` (the original's size is on the candidate / `extracted.image_width_px` / the file row).
2. **The sheet is the default click.** Clicking a row opens a 340 px sheet to the right of the list (the list stays visible; the selected row is
   highlighted; ArrowUp/ArrowDown move the selection and the sheet follows; Esc closes). The sheet holds the picture (preview, scale bar overlay),
   Link to…, Dismiss, **Open in view box**, and the imaging facts (`SemSettingsList`).
3. **The View rail (right).** The Inbox page gets the hanging right card of `DESIGN.md` section 4/5: Layout (Table / Cards), Density, Group by,
   **Preview** (what a click opens: Sheet or View box, default Sheet), **Compare** (tick a second row; "Compare two files"). It shows only settings that
   apply to the page. It is a page-local component (`InboxViewRail.vue`) that follows the proposed kit `ViewRail`; promoting it to `@d1/ui` is later.
4. **The view box is a page**, route `/inbox/file/:candidateId` (optional query `?with=<candidateId>` for the compare partner). Layout = `RecordLayout`
   shape: **left detail panel** (the `RecordRail` look: kind pill, "Found file" tag, file name in mono, folder, icon actions link / dismiss / copy path
   (a pin action needs a record reference; later), the facts, "On this page"), **centre** the stage (file name, "n of m" within the current filtered list, prev/next, close back to `/inbox` with the
   filters kept), **right** the View rail for the viewer: View (Fit / 1:1), Overlay (Scale bar, Measure, Contrast stretch), Compare (Off / Side by side),
   second-file picker, "Link zoom and pan", "Common scale".
5. **Compare.** The second file is chosen by a tick in the list (pre-fills the picker) or by the picker in the right rail (search within the same folder, then
   the whole list). Only files the person can already see are offered. A locked file (not theirs, not shareable) shows the existing lock card: no picture,
   no name. Side by side adds a facts diff under the stage; rows whose values differ are highlighted. Linked zoom/pan on by default. "Common scale"
   (default on) scales both pictures to the same µm per screen pixel when both have `pixel_size_nm`; otherwise it is disabled with a reason.
6. **Measure** (the full-size view box only; the sheet and the list do not have it) has three tools, chosen by a Line | Circle | Polygon control under
   Overlay > Measure (default Line; kept per person as `measureTool` in `localStorage`), with a hint for each and a Clear button. One shape at a time: a
   new one replaces the old. Each is kept as fractions (0 to 1) of the picture, so it holds at Fit, at 1:1 and when the picture is resized, and what it
   measures is worked out on the preview's own size from `pixel_size_nm` (stored per image, source `metadata` or `derived`) and the original's width.
   - **Line** (drag): its length, in µm (or nm below 1 µm): `212 µm`.
   - **Circle** (drag from the centre to the edge): diameter and area: `Ø 212 µm · area 35,299 µm²` (the radius and the circumference are worked out too).
   - **Polygon** (click the corners; close it by a click on the first corner, a double-click or Enter; Backspace takes the last corner off; at least 3
     corners): the area by the shoelace formula (the same whichever way round) and the perimeter: `area 12,400 µm² · perimeter 460 µm`. If two sides
     cross, the pill adds "check the outline" (the area is then not the area of one shape).
   Lengths are in µm (nm below 1 µm). Areas are in µm² (thousands separated, fewer decimals as they grow) and in mm² from 1 mm² up; never nm².
   Esc drops the shape being drawn (and, with nothing being drawn, still closes the view box). On an image with no known pixel size Measure is
   **disabled with the tooltip "no scale known for this image"** and has no tools. In Compare each pane keeps its own shape (still one at a time). A manual
   scale-bar entry is not built now.
7. **Where settings live:** the right-rail settings (Fit/1:1, overlays, Compare mode, Preview mode, Layout, Density, Group by) are kept per person in
   `localStorage` under `d1.list.inbox` (wrapped in try/catch; the page works without it). Only the file and the compare partner are in the URL.
8. **Kinds without a picture** (documents, other files, images whose thumbnail is not made yet): the sheet shows the facts and the existing placeholder
   or the shimmer, never a broken image. The view box page for them shows the facts and "No preview yet".
9. **Keyboard** (sheet and view box): `ArrowUp/ArrowDown` or `ArrowLeft/ArrowRight` previous/next,
   `Enter` opens the view box, `M` Measure (then `1` `2` `3` pick Line, Circle, Polygon; in a polygon `Enter` closes it and `Backspace` removes the last
   corner), `F` Fit, `C` Compare, `Esc` closes (or, while a shape is being drawn, cancels it). Every control has a visible `:focus-visible` ring.
10. **Nothing writes** except the existing link / dismiss actions, which keep their endpoints and their rules (an administrator can read but not change).

## Out of scope

Full-size streaming, a manual scale entry, a kit-level `ViewRail`, the hover card (separate), the table layout of the list (separate), annotations.

## Build order (three PRs, each stacked on the previous, each green on its own)

- **PR 1: sheet + Inbox View rail.** `InboxSheet.vue` (new), `InboxViewRail.vue` (new), `InboxView.vue` / `InboxRow.vue` (click opens the sheet,
  selection, keyboard), `useViewSettings.ts` (the localStorage store), `usePicture` reused for the preview. The old `PreviewDialog` stays reachable
  while Preview = View box until PR 2 (then it is removed).
- **PR 2: view box page.** Route `/inbox/file/:candidateId`, `InboxFilePage.vue`, `InboxFileRail.vue` (the left detail panel on `RecordLayout` /
  `RecordRail`), `ViewBox.vue` (stage, Fit / 1:1, scale bar, contrast), prev/next across the filtered list (the list is passed through router state or
  re-fetched with the same filters from the URL). Removes `PreviewDialog.vue`.
- **PR 3: Compare + Measure.** `ComparePicker.vue`, `CompareStage.vue` (two panes, linked zoom/pan, common scale), `FactsDiff.vue`,
  `useMeasure.ts` (pure maths: pixel distance to µm, preview/original ratio, unit formatting; unit-tested), the right-rail Compare and Overlay sections.

## Testing

Pure logic in `.ts` files with vitest (view settings store, measure maths, compare scale, next/prev selection, facts diff). Components with the existing
DOM test pattern (`*.dom.test.ts`, `fakeInboxServer.ts`). The fake server already serves pictures (`fakePictures.ts`); extend it for a second file.
Each PR: `npx vitest run` in `packages/starbase-pages`, `npm run typecheck`, the STARbase e2e untouched, CI green.

## Acceptance

PR 1: click a row, the sheet opens beside the list with picture + facts + actions; arrows move; Esc closes; the rail's Preview setting persists across
a reload. PR 2: Enter / "Open in view box" goes to the page with the left panel, the stage and the right rail; the browser Back returns to the list
with the same filters and selection. PR 3: tick two SEM images, open the view box, Compare shows both with linked zoom and a diff; Measure reads a
known distance on a synthetic image to within one pixel; Measure is disabled (with the reason) on an image without a pixel size.
