# Label printing in the Explorer — implementation plan

**Spec:** [`../specs/2026-10-12-label-printing-design.md`](../specs/2026-10-12-label-printing-design.md)
(read it whole; decisions 1-12 are the requirements).

**Goal:** label printing becomes an in-app Explorer page (`/admin/home/labels`), driven by DB
templates, with one HTML renderer for both the live preview and the print, and a self-describing QR
payload that D1 can scan back.

**Integration branch:** `feat/label-printing` (PR A). PR B (scanning) is `feat/label-scan`, cut
from `feat/label-printing` once S2 is merged.

## Status

| Stream | Worktree | Branch | Model | State |
|---|---|---|---|---|
| S1 migration | `.claude/worktrees/lp-s1` | `lp/s1-templates` | sonnet | in progress |
| S2 pure logic | `.claude/worktrees/lp-s2` | `lp/s2-logic` | sonnet | in progress |
| S4 cleanup | `.claude/worktrees/lp-s4` | `lp/s4-cleanup` | haiku | merged |
| S3 page | `.claude/worktrees/lp-s3` | `lp/s3-page` | sonnet | blocked on S1+S2 merge |
| S5 scanning | `.claude/worktrees/lp-s5` | `feat/label-scan` | sonnet | blocked on S2 merge |

Order: S1, S2, S4 run in parallel → review (Opus, `directus-ui-reviewer` / `migration-review`) →
merge into `feat/label-printing` → S3 → review → PR A → S5 → PR B.

## Global constraints

- Each worker works only in its own worktree. It never pushes, merges or rebases, and never edits this table.
- Commit after every step, using a Conventional Commit and the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
  (Haiku workers: `Claude Haiku 5.5`).
- `directus-ui-conventions` invariants apply. Use theme tokens only, read data as the signed-in user, put
  pure logic in `@d1/ui` with vitest tests, and keep files under ~400 lines.
- Gates: `npm test -w @d1/ui`, `npm run typecheck -w @d1/ui`, and for d1-home also its typecheck
  and `npm run build -w directus-extension-d1-home`. For d1-report, use `npm test` in its folder. For
  migrations, follow the `db-migration` skill (up/down/up).
- Live checks go on the preview Directus (:18055) only. Never use the main stack on :8055.

## Shared contracts (all streams code against these)

### `label_templates` table (S1)

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `name` | text, unique, not null | |
| `description` | text | |
| `media` | text, not null | `'sheet'` or `'roll'` (a roll has 1×1 and no "start at") |
| `page_width_mm`, `page_height_mm` | numeric, not null | for a roll, the page is one label |
| `columns`, `rows` | int ≥ 1 | |
| `label_width_mm`, `label_height_mm` | numeric > 0 | |
| `margin_top_mm`, `margin_left_mm`, `gap_x_mm`, `gap_y_mm` | numeric ≥ 0, default 0 | |
| `padding_mm` | numeric ≥ 0, default 2 | inner padding of each label |
| `arrangement` | text, not null | `'qr_top'`, `'qr_left'` or `'text_only'` |
| `qr_size_mm` | numeric, null | null = largest square that fits |
| `fields` | jsonb, not null, default `[]` | `[{ "key": FieldKey, "size": "lg"|"md"|"sm", "bold": bool }]` |
| `qr_fields` | jsonb, not null, default `[]` | extra FieldKeys in the QR payload |
| `is_default` | bool, default false | at most one true (partial unique index) |
| `user_created`, `date_created`, `user_updated`, `date_updated` | Directus accountability | plus the repo's OCC/audit conventions |

`FieldKey` = `sample_code` · `short_id` · `nickname` · `material` · `date` · `owner_initials`.

**Permissions** (the same mechanism as other collections in the repo):
- every lab role reads and creates;
- update and delete are allowed only where `user_created = $CURRENT_USER`;
- admins have full access.

**Seeds:**
- `A4 4×5`: 210×297, 4×5, 52.5×59.4, no margins or gaps, qr_top, fields code (lg, bold) and nickname (sm). It is the default.
- `L7160 21-up`: 210×297, 3×7, 63.5×38.1, margin_top 15.15, margin_left 7.25, gap_x 2.54, qr_left.
- `50×25 single`: roll 50×25, qr_left.
- `Brother DK-22205 62 mm`: roll, page 62×30, label 62×30, qr_left, code (lg, bold), short_id, nickname.

### `@d1/ui` labels module (S2), `packages/d1-ui/src/labels/`, exported from the index

```ts
type FieldKey = 'sample_code'|'short_id'|'nickname'|'material'|'date'|'owner_initials';
interface LabelField { key: FieldKey; size: 'lg'|'md'|'sm'; bold: boolean }
interface LabelTemplate { /* the table's columns, camelCased, numbers as number */ }
interface LabelSample { id: string; code: string; shortId: string; nickname: string|null;
  material: string|null; date: string|null /* YYYY-MM-DD */; ownerInitials: string|null }

toLabelSample(row): LabelSample          // from a physical_samples row as the page reads it
templateFromRow(row): LabelTemplate      // numeric strings → numbers, validated, defaults filled
validateTemplate(t): string[]            // human-readable problems (labels off the page, etc.)
slotPositions(t): {x:number,y:number}[]  // mm, row-major
paginate(samples, {copies, start}, t): (LabelSample|null)[][]   // null = skipped slot
fitText(text, boxWidthMm, size, bold): { pt: number; clipped: boolean; text: string }
buildQrPayload(s, extraKeys): string     // 'D1 SAMPLE\n<code> · <shortId>\n…'
parseQrPayload(text): { code: string; shortId: string; lines: string[] } | null
renderLabelDocument(pages, t, qrSvg: (payload:string)=>string): { html: string; clipped: number }
  // a full HTML document: @page size, mm absolute positions, white labels, no external
  // resources. Used as iframe srcdoc for the preview AND for the print. Escapes everything.
```

## Streams

### S1: `label_templates` migration (sonnet)
Owns `db/migrations/<ts>_label_templates.sql`, any Directus metadata rows for the collection
(fields, interfaces for `fields`/`qr_fields` as JSON or a list), the permissions, the seeds, and
`tests/phase1_schema.sh` additions. Uses the `db-migration` skill. Prove up/down/up on a scratch DB,
not :8055. Report the exact column list for S3.

### S2: pure labels logic (sonnet)
Owns `packages/d1-ui/src/labels/**` and the export lines in `packages/d1-ui/src/index.ts`. Use TDD
with vitest. Port the useful parts of `core/extensions/d1-report/src/label.js` (date, initials,
font sizing, pagination, validation) rather than reinventing them. No Vue and no Directus imports.
Tests must cover: the 4×5 and L7160 positions, start offset and copies, a roll giving one label per page,
clipping, payload round-trip (including `·` and newlines in a nickname), parse rejecting non-D1 text,
and HTML escaping.

### S4: cleanup and redirects (haiku)
Owns `core/extensions/d1-report/**` and `core/extensions/d1-report-button/**`, plus the docs below.
- `d1-report`: delete `label.js`, its routes and its tests. `GET /label` and `GET /labels` become a
  302 to `/admin/home/labels` (carry `ids`/`codes` over as `?ids=`/`?codes=`). They need no auth.
  Remove the `qrcode` dependency if nothing else uses it.
- `d1-report-button`: both buttons navigate in the same tab to `/admin/home/labels?ids=<pk>`, or
  `/admin/home/labels` for "several". There is no `window.open`.
- Docs: rewrite the label section of `docs/wiki/database/dashboards-and-reports.md` and the
  mentions in `getting-started.md:53` and `samples.md:55`. In the backlog, mark the three D4 items
  "Superseded by the Explorer labels page (PR #TBD)". Don't delete or tick them.

### S3: the labels page (sonnet), after S1+S2 are merged
Owns `core/extensions/d1-home/src/pages/LabelsPage.vue` plus children under
`core/extensions/d1-home/src/labels/`, the route, the `qrcode` dependency in d1-home,
`packages/d1-ui/src/nav/navConfig.ts:88` (point it to `/admin/home/labels`, drop `newTab`), the finder's skip at
`finder/finder.ts:178`, the `SamplePage.vue` and `QuickActions.vue` Print buttons (same-tab
router links, Sample → `?ids=<id>`), and a "Print labels for selected" action on the samples index.
- **Layout:** a PageShell with two columns.
  - Left is a Section "Samples": search, project/campaign filter, checkbox DataTable, a "paste codes" box, and copies per sample. It preselects from `?ids=`/`?codes=`.
  - Right is a Section "Template": a dropdown (remembered in localStorage, else `is_default`), "start at" for sheets, and the preview (iframe `srcdoc` = `renderLabelDocument`, scaled to fit, with "N labels on M pages, K clipped"). Print sends the same srcdoc to a hidden iframe and calls `contentWindow.print()`.
- **Template editor:** a panel toggled from the Template section. It has inputs for geometry, arrangement, an ordered fields list (add/remove/reorder, size, bold) and QR fields. The preview reads the draft live. Save, Save as new and Delete go through the SDK as the user. Controls are disabled when not permitted (`useCanUpdate`), and errors show inline.
- **Tests:** vitest for any new pure helpers. Run a headless render on the preview Directus (:18055), with screenshots of the page in light and dark and of the print document.
- Add the backlog checks: A4 4×5 print, QL-700 DK-22205 print through the Windows driver (paper 62 mm, 100% scale), and the template editor permissions for a non-admin.

### S5: scanning (sonnet), PR B
Owns the Finder payload handling (`packages/d1-ui/src/finder/**`), a scan component in d1-home
(camera via `getUserMedia` + `jsQR`), a Scan button in the Finder and on Home, and a decoded-label
card.
- A typed or pasted `D1 SAMPLE` payload resolves by short ID, then by code, and opens the Sample page.
- If it isn't found, isn't readable or there's a network error, show the decoded text and the reason. A non-D1 payload shows its text.
- Add a backlog check for a phone scan over `https://d1-server.tail54eeb6.ts.net`, on iPhone and Android.
