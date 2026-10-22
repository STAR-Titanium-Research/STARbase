# Process map creator: kinds in the palette, values on the cards

**Date:** 2026-10-22 · **Status:** design agreed with the maintainer in chat (2026-10-22), on a clickable mockup; written up for the plan.
**Delivery (maintainer, 2026-10-22, option A):** round 1 is everything except Feedstock (K7); the palette has four kinds in round 1.
Round 2 adds Feedstock together with the server change it needs (§6).
Amends [the edit mode redesign](./2026-10-18-process-map-edit-mode-redesign.md): where a decision below conflicts with an R-row there
(R1 above all), this document wins; rows not mentioned stand. Glossary: `CONTEXT.md` → **process map**, **palette**, **add search**,
**socket**, **template**, plus the new term **feedstock** (§4).

## 1. Why

The maintainer tried building a process from scratch and found the palette heavy and the cards silent:

- The palette lists every manufacturing method and test type (about 45 entries) in one plain list. Finding "Turning" means reading it.
- A new card says almost nothing on the map ("Turning · Makes 1 sample"); what it still needs is a list of red lines in the side panel.
- In the first minute: one click on "New sample" and an Enter added **two** samples (a click adds, the hint only mentions drag and
  Enter); an operation added after a sample is **not wired** to it; new cards land **out of sight** (under the minimap or off-canvas).

What they want instead, in their words: *"the palette should be simplified with material, samples, operations etc. When I pick an
operation, then I pick what kind of operation from a drop down and that loads the required fields in the process map showing me what
is missing"* — and they want to **type the values into the card itself**.

## 2. Goals

1. The palette offers **kinds**, not every method: Sample, Feedstock, Operation, Test, From database…, with Recents under them.
2. A dropped Operation (or Test) card asks **what kind** it is with a dropdown **on the card**. Choosing one makes the card show that
   kind's **required fields plus its key settings** (at most four), editable **on the card**.
3. Empty required fields are **marked on the card** (amber), and the card's header says how many are missing.
4. Typing a method in the add search (Shift+A / Ctrl+K), e.g. "Turning", still adds an Operation card **with that kind already
   chosen**, in one step.
5. The three first-minute frictions are gone: one click adds once, a new card lands in view and is selected, and an operation (or
   test) added right after a sample is wired to it.

## 3. Non-goals

- Every field on the card. Everything beyond the required fields and the key settings stays in the side panel ("All fields").
- Changing what Create writes, what `d1-build` accepts, or any schema. This is a front-end change to how a draft is built and shown.
- A new material record. Feedstock picks an existing stock lot or an existing material; registering either stays where it is today.
- Recorded (done) records: their cards keep today's read-only look; inline editing is for draft items (new, or planned and editable
  under today's rules).

## 4. Decisions

| # | Decision |
|---|---|
| K1 | **Palette = kinds.** Entries, in order: **Sample** (a new one; "Existing sample…" stays inside it, see K6), **Feedstock** (round 2), **Operation**, **Test**, then **From database…**. Below them, **Recents** (the last six specific things added, as today: "Turning", "FAST/SPS sintering", a template…). Templates stay reachable (in Recents when used, and in the add search). Each entry has the icon and kind colour the map already uses (sample purple, operation orange, test teal, feedstock the recipe/stock green). The per-method list is **removed from the palette**. Replaces R1's "both surfaces are one flat list" for the palette only. |
| K2 | **The add search keeps every method and test type.** Typing "Turning" and choosing it adds an Operation card with Turning chosen (one undo step), exactly like K1's Operation followed by K3's choice. The search also lists the five kinds. Opened at a socket, it keeps filtering to what can legally connect (R2). |
| K3 | **Kind on the card.** A freshly added Operation card shows only a header (kind pill, "kind?" marker) and a dropdown "Choose the kind…" grouped by process category (Machining, Sintering, Conform, Heat treatment, Deformation, Additive, Sample preparation, Other); a Test card the same with test types grouped Non-destructive / Destructive / Dynamic / Other. Choosing sets the draft item's method (`method_id`) or test type. Changing the kind later keeps the values of fields both kinds share and drops the rest (one undo step). An operation with no kind is a draft item with no method: Create stays refused and the checks say "Choose what kind of operation this is". |
| K4 | **What the card shows once the kind is chosen:** the kind's **required fields** (as the checks define them today) and its **key settings** (`KEY_SETTING_FIELDS` / spec §6.4 of the process map design: at most four), in that order, without repeats. Relations (machine, tool, insert edge, recipe) are drawn as today's **slotted rows with their icon** (the look the maintainer likes), with a picker inline; scalar fields as compact inputs with their unit on the right; a date as a date input. A link at the bottom, "All fields in the side panel", selects the card and opens its form. |
| K5 | **Typing on the card.** Values typed on a card are the same draft values the side form edits (one source: the draft item's `values`); typing in one updates the other. Each field commit is one undo step (on change / blur, not per keystroke). Keyboard: Tab moves through the card's fields; Escape leaves the field and keeps the card selected. Typing in a card's field never triggers the map's shortcuts (Delete, I, Shift+A, the arrow keys) and never drags or pans. |
| K6 | **Sample card (new).** Shows its required fields on the card: **Name** (the label), **Material** (a dropdown of existing materials), **Geometry**, and **Made by** (the manufacturing method of the sample's code), plus the dimensions the geometry needs only in the side panel. "Existing sample…" is offered on a new Sample card (a "Use an existing sample instead" link that opens today's sample picker and replaces the card) and in the add search. A recorded sample's card is unchanged. |
| K7 | **Feedstock card (round 2).** A new palette kind for what goes **into** an operation that starts from powder or stock (FAST, additive, Conform…): pick a **stored stock lot** (`raw_stock_lots`) or, when none is recorded, a **material** ("None recorded: use a material"). Optional mass used. It has one output socket and wires into an operation's input, the way the map already draws a stock lot feeding a FAST run (D12). A sample's material is **not** a feedstock card: it is the Material field on the sample card (K6). How a feedstock wire is written at Create follows what `d1-build` already accepts for stock provenance (`sample_stock_provenance`: lot + mass, against the operation's output sample); where `d1-build` has no way to write the material-only case, the material-only feedstock fills the output sample's Material instead and says so on the card. The builder confirms which of these `d1-build` supports today before building K7 (see §6). |
| K8 | **Missing, on the card.** An empty required field is amber (border and tint) with an asterisk on its label; the card header carries "N missing" (amber) or "ready" (green). The draft bar shows the total ("N to fill in"). Red stays for what would actually be **refused** (the existing server-only checks, a wire `d1-build` would reject). |
| K9 | **One click adds once.** A click on a palette entry adds it (as today) and the hint says so ("Click, Enter or drag to add"); a second add of the same entry within ~0.5 s of the first is ignored (the double-add guard), so click-then-Enter adds one card. The new card flashes briefly. |
| K10 | **A new card lands in view and is selected.** After any add (palette, add search, insert before/after, a drop), the map pans the smallest amount needed to show the new card (the existing reveal behaviour), selects it, and focuses its kind dropdown (or its first empty field when the kind is already chosen). |
| K11 | **Wired to what you just added.** When an Operation or Test is added without a target (palette click/Enter, add search not at a socket) and the **selected** card is a sample with a free output (or, with nothing selected, the most recently added sample in this draft), the new card is connected to it, if the connection is legal (the same rules as a drop on that socket, `addDrop.ts`). Otherwise it lands floating, as today. One undo step undoes the add and the wire together. |
| K12 | **Draft bar in three groups.** Left: undo, redo, Add, Pick samples, Tidy. Middle: the draft's name, Project, Campaign. Right: "N to fill in" and **Create**, always in the same place, disabled with the count until the draft can be created. The rest of today's bar (My drafts, delete draft, merge, Draft kept) moves under a "Draft ▾" menu in the middle group. |
| K13 | **Draft card status: one mark each.** The dashed outline means draft. The corner "Draft · planned" tab goes; the Planned/Done chip and the missing count stay in the header, so the title is no longer cut ("Machining · Turning"). |

## 5. Constraints

- **STARbase design rules:** CONTEXT.md vocabulary on screen; the maintainer's 2026-10-22 polish (PR #403: names first, ring in the kind
  colour, ＋ on hover, fit to canvas) is assumed merged or merged in first; the kind pills stay.
- **One draft model.** Cards and the side form edit the same draft item; no second copy of values. Undo/redo, drafts saved to the
  server (`d1_private` drafts), templates and Create keep working unchanged.
- **Layout:** cards grow when fields appear (K4). Growth must not shove cards the person dragged (R6: positions the person dragged are
  kept); the existing reflow (`reflow()`: room is made round the card that grew) is the mechanism.
- **Accessibility:** every inline field has a label (visible or `aria-label`), Tab order follows the card top to bottom, focus is
  visible, amber "missing" is not colour-only (asterisk + header count + accessible description).
- **Phones (< 768 px):** edit mode is not offered on phones today (E20); unchanged.
- **Tests:** unit tests for the pure parts (which fields a kind shows, the double-add guard, the auto-wire choice, kind change keeping
  shared values); the local-stack e2e (`tests/ui/specs/edit-mode*.spec.ts`, `scripts/dev/local-stack.sh`) updated for the new palette and
  extended with: add Operation → choose Turning → type cutting speed on the card → the side form shows it → Create writes it.

## 5a. Calls made after the builder check (Claude's, for the maintainer to check)

- **"Made by" on a sample card (K6)** is editable only on a sample that nothing in the draft makes. On a sample that is the output of a
  draft operation it is shown read-only, taken from that operation's kind (the same value the sample's code is built from; today's
  `inherit.ts` already infers it). So there is never a disagreement to resolve, and K8 counts it missing only on a sample nothing makes.
- **Several output rows (K4, K11).** The fields on an operation card are the operation's own; nothing per row. K11's "free output" means
  a **sample's** free output socket only, never an operation's row.
- **Changing the kind (K3)** needs no confirm: the change is one undo step, and a short notice says what was dropped ("Kind changed to
  Milling: feed and depth of cut kept, 1 value dropped · Undo").

## 6. Left to the builder

- Exactly which fields are "required" per kind: read them from today's checks (`edit/checks.ts`) and field definitions; do not invent new
  requirements.
- Inline field components: reuse the kit's `FieldForm` in its `compact` mode (it already draws `keyFields`) where that fits, or a thin
  card-sized variant of it.
- K7 (round 2): the builder check found `d1-build` writes no stock provenance at all, and the draft types (`@d1/ui` `build/types.ts`) have
  no feedstock item or wire. Round 2 designs both: a feedstock draft item (or an operation field), its wire, the `d1-build` write of
  `sample_stock_provenance` (lot + mass against the operation's output sample) and the material-only fallback, with saved drafts that
  predate it still loading. Not part of round 1.
- Slicing (round 1): a sensible order is K9–K11 (frictions) → K1–K3 (palette and kind dropdown) → K4–K5, K8 (fields on the card) → K6
  → K12–K13, each slice shippable on its own.
- Visual reference: the mockup this was agreed on (`creator-mockup.html`, attached to the PR).
