# Handoff spec: rig test requests UI (force app)

**Date:** 2026-10-12
**Status:** Describes the phase-1 UI as built on the PR that adds this feature (#237). Written from
the code, not from a mock-up. Use it to restyle, extend for phase 2 ("Run automated only", automated
steps), or port the UI. Behaviour lives in `apps/force-app/web/src/rigtest/rigTestLogic.ts`, so pure
rules are cited by function name. Design and decisions:
[`2026-10-11-rig-test-requests-design.md`](2026-10-11-rig-test-requests-design.md),
[ADR-0012](../../adr/0012-rig-test-requests-over-github-issues.md).

## Overview

A maintainer asks for physical checks from a GitHub issue. The force app on the rig PC must:

1. **Ask** whoever is using the rig for permission, without ever getting in the way of a recording.
2. **Guide** them through each check: a question, answer buttons, an optional note and a countdown.
3. **Stay out of the way** while it runs: it can be minimised, the rest of the app stays usable, and
   Cancel is always one click away (with a confirmation).

The operator is a lab member mid-session, often wearing gloves, at arm's length from a 24" screen,
and often in the middle of a cut. Every layout and state rule below follows from: **never cover
the Record page during a cut, and never take keyboard focus from the recording Save dialog.**

| Surface | Component | When it shows |
|---|---|---|
| Sidebar badge | `AppShell.vue` (`.badge.rig`, `.rig-dot`) | A request is pending but the app is blocked (a cut, the Save dialog, backend busy, or state unknown) |
| Consent prompt | `RigTestPrompt.vue` + `RigTestRequestCard.vue` | A request is pending and the app is not blocked |
| Run modal | `RigTestRunModal.vue` | A run is active, not minimised and not blocked, or a run just finished |
| Minimised bar | `RigTestBar.vue` | A run is active and minimised or blocked |
| Settings → Rig tests | `settings/RigTestsSettings.vue` | Always available; lists pending, snoozed and past requests |
| Cancel confirmation | `confirmCancel.ts` (shared `confirmAction`) | Cancel pressed in the modal or the bar |
| OS notification | desktop `notify.ts` | A new request or question while the window is unfocused |

Mounting: `RigTestHost.vue` is mounted once in `AppShell.vue`, in the **main window only**. Pop-out
windows (`?popout=1`) never host it.

## Layout

The app is a desktop Electron window, usually 1280 to 1920 px wide. All three overlays are fixed
and centred over the page.

| Surface | Box | Spacing |
|---|---|---|
| Prompt backdrop | `position: fixed; inset: 0`, flex-centred, padding 24 px | |
| Prompt panel | `width: min(520px, 100%)`, `max-height: 100%`, scrolls inside | padding 20, gap 14 |
| Run modal panel | `width: min(600px, 100%)`, `max-height: 100%`, scrolls inside | padding 20, gap 12 |
| Minimised bar | fixed bottom-centre, `width: min(900px, 100vw − 24px)`, height `--rig-bar-h` (44 px) | padding 0 12, gap 10 |
| Request item list | max-height 150 px, scrolls | padding 8 10, gap 4 |
| Run step list | max-height 220 px, scrolls; top and bottom 1 px rule | row padding 5 2, gap 8 |
| Progress rows | 3-column grid: `44px 1fr 92px` (label, track, value) | gap 10, row gap 6 |

While the bar is shown, `RigTestHost` sets `--rig-bar-h: 44px` on `<html>`. `AppShell`'s `.content`
adds `padding-bottom: var(--rig-bar-h, 0px)`, so page content is never hidden behind the bar.

### Layering (z-index)

Pinned by `web/src/z-order.test.ts`. Do not change a number without updating that test.

| Layer | z | Note |
|---|---|---|
| Recording banner | 150 | below everything here |
| Update prompt | 180 | shares the bottom corner with the bar |
| **Minimised bar** | **185** | |
| **Consent prompt, run modal** | **190** | |
| Recording Save dialog | 200 | must stay above the rig-test layers |
| Alarm banner | 290 | |
| Confirm prompt (Cancel confirmation) | 300 | opens above the modal that triggered it |

## Design tokens used

All values come from `apps/force-app/web/src/styles.css`. Each has a dark and a light value; the
dark one is listed. Only tokens appear in the rig-test CSS, except the gaps noted under "Token gaps".

| Token | Dark value | Usage |
|---|---|---|
| `--overlay` | `rgba(0,0,0,0.55)` | Backdrop of the prompt and the run modal (with `backdrop-filter: blur(2px)`) |
| `--bg-2` | `#161d29` | Panels, the bar, text inputs |
| `--surface` | `#1b2433` | Item list, snooze and decline panels, "finished" banner |
| `--surface-2` | `#232e40` | Progress track |
| `--border` / `--border-2` | `#26323f` / `#34425a` | Panel and input borders / the bar's and chips' borders |
| `--text` / `--text-dim` / `--text-faint` | `#e6edf5` / `#8494a8` / `#61708a` | Body / meta and labels / time-progress fill |
| `--accent` / `--accent-ink` | `#f5a524` / `#12161f` | Science icon, item ids, steps fill, question box tint, "Waiting for you" pill |
| `--ok` / `--warn` / `--danger` | `#4ade80` / `#fbbf24` / `#fca5a5` | Step marks, finished banner, countdown under 30 s, errors |
| `--fs-xs` … `--fs-xl` | 11 / 12 / 13 / 15 / 18 px | Pill / meta and labels / body and buttons / request title and question / dialog titles |
| `--icon-md` / `--icon-xl` | 18 / 24 px | Inline icons and step marks / header science icon |
| `--font`, `--mono` | Inter / JetBrains Mono | Body / `<code>` item ids |

Type roles: dialog title `--fs-xl`, line-height 1.25. Question text `--fs-lg`, line-height 1.5,
`white-space: pre-wrap`. Section tags `--fs-sm`, 700, uppercase, letter-spacing 0.04em.

### Token gaps (hard-coded today)

Worth turning into tokens if the app gains a spacing and radius scale:

| Value | Where | Suggested token |
|---|---|---|
| `border-radius: 14px` on the panels | prompt, modal | `--radius` (already 14 px, so it can be used as is) |
| 9 px, 11 px and 12 px radii | inner panels, question box, bar top corners | `--radius-sm` / `--radius-md` |
| 99 px | chips, pills, progress track | `--radius-pill` |
| `0 30px 80px rgba(0,0,0,.45)` | panel shadow | `--shadow-dialog` (shared with other dialogs) |
| `0 -6px 24px rgba(0,0,0,.3)` | bar shadow | `--shadow-dock` |
| 24, 20, 14, 12, 10, 8, 6, 4 px | paddings and gaps | `--space-*` scale |

## Components

| Component | Variant or state | Data (from the backend contract) | Notes |
|---|---|---|---|
| `RigTestPrompt` | dialog | the oldest pending `Request`; count of others | Heading "Your admin has requested tests on this rig". Footer "N more requests are waiting; they are offered one at a time." |
| `RigTestRequestCard` | in the prompt; in Settings | `number, title, url, requested_by, created_at, items[], estimate_s.full, needs_operator_steps, error?` | Shared, so the prompt and Settings behave the same |
| `RigTestRunModal` | running, question open, working, finished | `Run` (`title, url, steps[], current, question?, estimate_s, elapsed_s, state`) | Finished state replaces the footer with **Close** |
| `RigTestBar` | normal; `asking` (accent border plus pill) | `Run` | Pill text from `barAskText(blocked)` |
| Sidebar badge | count; collapsed-handle dot | `pending.length` | `title`: "A rig test has been requested (Settings > Rig tests)" |
| `RigTestsSettings` | eligible or not; pop-out note; empty lists | `/rig-tests/eligibility`, `/pending`, `/history` | Sections: lead text and status → "Waiting for you" → "Snoozed" → "Recent runs" |

### Button set (existing `.btn` classes)

| Button | Class | Icon (Material Symbols Rounded) |
|---|---|---|
| Run now | `btn primary` | `play_arrow`, or `hourglass_top` while accepting |
| Snooze | `btn`, `.on` when its panel is open | `snooze` |
| Decline | `btn quiet`, `.on` when its panel is open | `block` |
| Decline request (confirm) | `btn danger` | `block` |
| Answer options | `btn` (one per option) | none |
| Minimise | `btn` (footer), `btn icon sm` (header) | `minimize` |
| Cancel test | `btn danger quiet` | `cancel` |
| Show (bar) | `btn sm` | `open_in_full` |
| Cancel (bar) | `btn sm danger quiet` | none |
| Snooze and decline-reason chips | `.chip`, `.on` and `aria-pressed` when picked | none |

## Content

### Copy

Change copy here and in `rigTestLogic.ts` together; unit tests pin the strings.

| Where | Text |
|---|---|
| Estimate (prompt) | `Full run: about 12 min, 3 steps need you` · `about 4 min, nothing needed from you` · 1 step → "1 step needs you" · over 90 min → "1 h 35 min" · never "0 min" |
| Bar | `Rig test #231, step 4/9, about 6 min left` (`under a minute` when 30 s or less is left) |
| Bar pill | `Waiting for you`, or `Waiting for you — after this cut` while blocked |
| Question tag / countdown | `Step 4 needs you` / `Answer within 4:33` → `Time is up: recording no response` |
| Finished | `Rig test finished: every step passed` · `…some steps did not pass` · `Rig test cancelled` · `Rig test ran out of time` |
| Snooze presets | `In 30 minutes` · `In 2 hours` · `After this recording` · `At [time]` |
| Decline reasons | `About to record / mid-session` · `Someone else is using the machine` · `Rig not set up (no tool or sensor)` · `Not today, ask tomorrow` · `Other…` (shows a textarea) |
| Cancel confirm | Title `Cancel the rig test?`; body "The run stops now. Steps not yet done are recorded as cancelled, and the result is posted to the issue."; buttons **Keep running** (default) / **Cancel the test** |
| Relay status (Settings) | `Request relay reachable` · `…unreachable: new requests cannot arrive` · `…not checked yet` · `…not configured on this PC` · `The relay rejected this PC's rig token: it must match the one set on the server` |
| OS notification | Title `Rig test requested by <login>`, body `#N <title> (<estimate>)`; question: `Rig test #N needs you` / question text |

### Limits

| Field | Limit | Behaviour |
|---|---|---|
| Request title, item text | none in the UI (backend caps request text at 1000; bundled prose at 4000) | Wraps (`overflow-wrap: anywhere`), never truncated in the prompt |
| Step text in the run list | — | Clamped to 2 lines (`line-clamp: 2`); the full text is in the question box |
| Question text | 1000 (request) / 4000 (prose) | Full text, `pre-wrap`, the modal scrolls |
| Answer options | ≤ 6 | Wrap onto more rows |
| Note | 500 characters (`maxlength`) | Optional; hidden for `note` steps |
| Decline "Other" text | 300 (`DECLINE_TEXT_MAX`, matches the backend) | Decline is disabled until a reason is picked, and "Other" needs text |
| OS notification title and body | 200 each (`NOTIFY_MAX`, also checked in the main process) | Clipped with an ellipsis |
| Request issue link | must be `https://github.com/<o>/<r>/issues/<n>` (`httpUrl`) | Anything else renders as plain text, with no `href` |

## States and interactions

### Which surface shows

The decision functions are pure. Change behaviour there, not in the components.

```
blocked = phase ≠ null (recording | finalizing | unknown) OR saveDialogOpen OR pending.busy      — rigBlocked()
prompt  = none   if no pending OR a run is active
        = badge  if blocked
        = dialog otherwise                                                                     — promptMode()
run     = modal  if just finished AND not blocked (else held until unblocked)
        = bar    if running AND (minimised OR blocked)
        = modal  if running                                                                    — runView()
```

"Unknown" (no `/record/status` answer yet, e.g. right after a reload) counts as blocked. A missed
prompt shows up a moment later as a badge; a prompt over a live cut costs the operator the cut.

### Per element

| Element | State | Behaviour |
|---|---|---|
| Run now | default → accepting | Icon becomes `hourglass_top`; all three buttons are disabled |
| Run now | refused (409) | Backend `detail` shown inline under the estimate in `--danger`, with an `error` icon and `role="alert"` |
| Run now | request invalid (`request.error`) | Disabled; the error is shown above the estimate |
| Snooze / Decline | toggle | Opens its inline panel (only one at a time); `aria-expanded` follows it |
| Chip | hover / picked / disabled | Text goes `--text` / accent text, 55 % accent border, 12 % accent fill / opacity 0.5, not-allowed cursor |
| Item link | hover | Underline; opens GitHub in a new window (`rel="noopener"`) |
| Modal | a new question arrives | Reopens itself, once per question (`shouldReopen`), unless blocked; then only the bar pill shows |
| Modal | Minimise (button, header icon or Escape) | Becomes the bar; the run keeps going |
| Answer button | answering / time is up | Disabled while the answer is sent; disabled when the countdown reaches 0 |
| Countdown | ≤ 30 s | `--warn`, weight 600 |
| Step row | status | Icon and colour from `stepMark()`: pass `check_circle`/ok · fail `cancel`/danger · error `error`/danger · no response `timer_off`/warn · skipped `remove_circle_outline`/dim · cancelled `block`/dim · active `play_circle`/accent · waiting `radio_button_unchecked`/dim; the current row is `--text`, weight 600 |
| Cancel (modal or bar) | press | Confirmation at z 300; the default focus is **Keep running** |
| Bar | question open | Accent border plus an uppercase pill |
| Sidebar | request while blocked | Accent count badge on the Settings item; a dot on the collapsed nav handle |
| Show / Run now | while blocked | They still open the surface (`forced`); Minimise or a new question clears that |

## Responsive behaviour

Desktop-only app, but the panels must survive a narrow window and the browser build used over
Tailscale.

| Width | Changes |
|---|---|
| > 900 px | The bar is 900 px, centred; the panels are 520 / 600 px |
| 600–900 px | The bar fills the window minus 24 px; the modal fills the width minus 48 px |
| < 600 px | Panels are full width inside the 24 px backdrop padding; action buttons and chips wrap; bar text ellipsises, while the pill, Show and Cancel keep their size |
| Short windows | Panels are `max-height: 100%` with internal scroll; the item list (150 px) and step list (220 px) scroll on their own |

## Edge cases

- **Several requests:** the prompt shows only the oldest one, plus "N more…". Settings lists them
  all, each with its own actions.
- **Empty states (Settings):** "No requests are waiting." and "No rig tests have run on this PC
  yet." The "Snoozed" section is hidden when there are none. Ineligible PCs show the reason (no NI-DAQ hardware, no rig token, relay not
  configured) and no actions.
- **Pop-out windows:** never show the prompt or modal. Settings in a pop-out says requests are
  answered in the main window.
- **Reload mid-run:** the modal title comes from `Run.title`, falling back to "Rig test #N" if an
  older backend didn't send it.
- **Slow or offline relay:** nothing pops. Settings shows the relay status. The backend keeps
  results to send later, so the UI needs no retry control.
- **Older backend (404 on `/rig-tests/*`):** the feature hides itself completely.
- **Long titles and ids, other languages:** everything wraps, nothing has a fixed width except the
  progress grid's 44 px label column. A longer translation of "Steps" or "Time" needs that column
  widened.
- **Question expires while typing a note:** the buttons disable at 0. The note is cleared when the
  next question arrives.

## Animation and motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Prompt | show / hide | opacity 0 ↔ 1 (`rt-fade`) | 120 ms | ease |
| Prompt and modal panels | mount | shared `dialog-in`: opacity 0 → 1, translateY 8 px → 0 | 180 ms | `cubic-bezier(0.2, 0.9, 0.3, 1)` |
| Progress fills | step done / time tick | width | 400 ms | ease |
| Bar dot | while the bar is shown | shared `live-pulse` keyframes in accent | 1.4 s loop | — |
| Working indicator | between steps | `progress_activity` icon with the shared `spin` class | — | linear |

`prefers-reduced-motion: reduce` is already handled app-wide in `styles.css`: animations and
transitions drop to 0.01 ms, and the pulse runs once. `.spin` is deliberately kept turning slowly
(2 s) so "working" still reads as working. Nothing rig-test specific is needed.

## Accessibility

- **Roles:**
  - The prompt and the modal: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at
    their `<h2>`.
  - The bar: `role="region"`, `aria-label="Rig test in progress"`.
  - The progress tracks: `role="progressbar"` with `aria-valuenow`, `aria-valuemin` and
    `aria-valuemax`.
  - The question box: `aria-live="assertive"`.
  - The finished banner: `role="status"`.
  - Errors: `role="alert"`.
- **Focus:** `useDialog` traps focus inside the prompt and the modal, and returns it on close.
  Neither may mount while the Save dialog is open (that is the `saveDialogOpen` rule), so Tab can
  never land in a hidden rig-test panel.
- **Keyboard:**
  - Prompt: no Escape and no click-away. A request is answered, never dismissed by accident.
  - Modal: Escape **minimises** and never cancels. In the finished state Escape closes.
  - Everything is reachable by Tab; the chips are buttons with `aria-pressed`.
- **Screen readers:**
  - Each step row has hidden status text (`.rm-sr`: "passed", "no response" and so on).
  - Decorative icons and the bar dot are `aria-hidden`.
  - The minimise icon button has `aria-label="Minimise"` and a tooltip saying "the test keeps
    running".
- **Targets:** the answer buttons are standard `.btn` size. If operators wear gloves, consider a
  larger variant for the answer row only.
- **Colour:** status is never colour alone. Every step mark has its own icon, and the countdown also
  changes weight.

## Phase 2 notes

- Add **Run automated only** as a second `btn` after Run now, with its own estimate line
  ("Automated only: about 4 min, nothing needed from you"). Grey it out when there are no automated
  steps and hide it when every step is automated (spec, "Web").
- Automated steps show in the step list with the `play_circle` / `active` mark and the
  `rm-working` line. No question box.
- While an automated step holds the rig, the backend returns 409 for recording and hardware writes.
  Pages that call those endpoints should show the backend's message as they do any 409; no new
  rig-test UI is needed.
