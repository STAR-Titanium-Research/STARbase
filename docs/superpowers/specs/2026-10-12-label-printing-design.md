# Label printing in the Explorer

Status: **decisions taken by the maintainer on 2026-10-12** (grilling session, Q1-Q25). Next step:
write the implementation plan in `docs/superpowers/plans/` with a Status table, then run the
streams below. Branch: `feat/label-printing`.

Why: the label pages (`/d1-report/label`, `/d1-report/labels`) are server-rendered HTML in a
separate tab, with hard-coded colours (`core/extensions/d1-report/src/label.js:230-259`), no dark
mode and none of the `@d1/ui` look. The maintainer finds they look out of place and work badly
(opening `/d1-report/labels` gives 401 "Authentication required." locally; diagnose before
deleting). Wanted: several label types, a live preview, and labels that still identify a sample
without the database.

## Decisions

1. **An in-app page, not a tab.** `/admin/home/labels` in d1-home, built from kit components
   (PageShell, Section, DataTable, Finder-style search) and theme variables. Nothing opens in a
   separate window. The sidebar entry loses `newTab` (`packages/d1-ui/src/nav/navConfig.ts:88`).
2. **One renderer for preview and print.** The page renders the real pages (mm geometry, `@page`
   size) and Print sends the same markup to a hidden print-only iframe. The QR is generated in the
   browser. On screen the labels stay white paper in dark mode, but the page around them follows
   the theme.
3. **Printers:** browser printing only. Office lasers (A4 sheets) and a Brother QL-700 on USB
   through its Windows driver (not networked yet). Direct printer protocols are out of scope.
4. **Samples only** for now.
5. **Templates in a `label_templates` collection** (one table, no separate stocks table). Each row
   holds:
   - geometry: page w × h (or continuous roll width × label length), columns × rows, label
     w × h, margins and gaps
   - an arrangement: QR on top with text centred, QR on the left with text on the right, or text
     only
   - an ordered list of fields (sample code, short ID, nickname, material, date, owner initials),
     each with a size (large/normal/small) and bold on or off
   - the extras that go into the QR payload (see 7; all of them by default)
6. **Template permissions:** everyone reads and creates; owners edit and delete their own;
   admins edit and delete all. Seeds:
   - the maintainer's A4 4 × 5 sheet (52.5 × 59.4 mm, edge to edge, QR on top, then the code in
     bold, then the nickname; the default)
   - L7160 21-up (63.5 × 38.1 mm)
   - 50 × 25 single
   - Brother DK-22205, a 62 mm continuous roll, QR on the left
7. **QR payload: self-describing text**, readable by any phone with no network, login or database
   access, so that anyone who finds a sample can identify it and contact someone (decided
   2026-10-12; it replaces the first, shorter format). The first line is fixed so it can be parsed
   and versioned:
   ```
   D1 SAMPLE
   S-0123 | 1a2b3c4d
   Ti-6Al-4V | "bracket A"
   2026-10-01 | DP
   dp@example.org
   Contact: lab@example.org
   ```
   Separators are ASCII ` | ` (a USB scanner types keystrokes and cannot type `·`; labels printed
   with ` · ` before are still read). An empty value is left out and a line with both values empty
   is dropped. Line breaks and tabs inside a value become spaces.
   - The code and short ID are always included. Every sample already has a short ID
     (`db/migrations/20261010000150_short_ids.sql` back-fill and trigger).
   - The rest (material, nickname, date, owner initials, owner email, the lab contact email) is in
     every template's QR by default: `qr_fields` lists them and an empty or NULL list means all, so a
     template can still leave some out (the editor shows "All (default)").
   - The owner email is `people.email` of the sample's owner. Lab Members already read `people` in
     full (`scripts/access_rules.json`, `people`: read `*`), so the labels page asks for
     `owner_person_id.email` in the same query as `owner_person_id.full_name` and no permission
     widens. A sample whose owner has no email just has no email line.
     **The owner email is printed on labels that anyone can read, and a label outlives the owner's time at
     the university.** A template that should not carry it opts out by unticking "Owner email" in its QR
     extras (untick "All (default)" first).
   - The lab contact is the singleton `label_settings.contact_email`: everyone reads it, only admins
     write it (inline on the labels page, one PATCH). Empty means no Contact line.
   - **Density.** The payload is about 150 to 200 characters, so the QR has more modules. The
     renderer draws error correction M while a module stays at least 0.33 mm on the label, else L,
     and the preview says "QR may be hard to scan on this label size" when modules are under 0.3 mm
     even at L.
8. **Page flow.**
   - The left column is the picker: search, filter by project or campaign, tick boxes, paste
     codes, and copies per sample.
   - The right column holds the template dropdown, "start at position" (sheets), the live
     preview and Print.
   - The page is opened from the Sample page's Print label (preselected), the Home tile, the
     sidebar, the `d1-report-button` form interface and a new "Print labels for selected" action
     on the samples index.
   - The last-used template is remembered in the browser.
9. **Template editor** on the labels page: geometry, arrangement and fields, with the preview
   updating as you type. It saves as the signed-in user. The plain Directus form stays as an
   admin fallback.
10. **Overflow:** each field shrinks to a minimum size, then is cut off with "…". The preview
    flags labels that were clipped.
11. **Old pages:** delete the label code from `d1-report` (`label.js`, its routes in `index.js`,
    its tests), and redirect `/d1-report/label(s)` to the new page. The form interface buttons
    point to the new page.
12. **Scanning (second PR).**
    - The Finder recognises a typed or USB-scanned `D1 SAMPLE` payload and jumps to the sample.
    - A camera "Scan" button in the Finder and on Home decodes with a small library (e.g.
      `jsQR`), so iPhone Safari works. It needs HTTPS, which the server already has through
      Tailscale Serve (`infra/README.md:16`).
    - If the record can't be opened (deleted, no access, server unreachable), the page shows the
      decoded label text with the reason. Non-D1 payloads show their text.

## Delivery

- **PR A:**
  - S1: migration for `label_templates` with permissions and seeds (`db-migration` skill)
  - S2: pure logic in `@d1/ui` with vitest tests: geometry, pagination, text fit, QR payload
    build and parse
  - S3: the d1-home labels page, editor, preview and print
  - S4: cleanup: d1-report removal and redirects, form interface, sidebar, wiki
    (`docs/wiki/database/dashboards-and-reports.md`), backlog
- **PR B:** S5, Finder payload parsing and camera scan.
- **Testing:** on the preview Directus (:18055). Backlog: mark the D4 items in
  `docs/runbooks/physical-test-backlog.md` "superseded by PR #…" (don't delete them). Add checks
  for an A4 4 × 5 print, a QL-700 DK-22205 print and a phone camera scan over the tailnet.
- **Agents:** implementers on Sonnet 5.5 (Haiku 5.5 for mechanical streams such as S4), using the
  `directus-ui-implementer` profile. Review by `directus-ui-reviewer` on Opus 5.5 at medium effort.
  Keep briefs and reports lean.
- **Out of scope:** the maintainer's uncommitted `docker-compose.yml` and `infra/backup/backup.sh`
  edits on `main`. Don't touch them.
