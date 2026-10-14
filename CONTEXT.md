# D1-Database — Context

The database of the STAR group (Sheffield Titanium Alloy Research) for samples, the operations
done to them and the tests run on them, and the people and projects behind that work.

## Language

### STARbase

**STARbase**:
The group's own web app for reading, finding and moving between records. It is also the home of
the lab's plotters. It reads, finds and navigates; creating and editing a record is done with
**Data Studio**'s form.
_Avoid_: Explorer (its working name), frontend, head, lab-web, d1-home

**Home**:
STARbase's landing page: the lab view for everyone, and the admin overview for administrators.

**Index page**:
A STARbase page that lists the records of one kind, with search and a few fixed filters.
_Avoid_: list view, collection page, list

**Record page**:
A STARbase page about a single Project, Campaign, Sample, Operation or Test.
_Avoid_: detail page, item page

**Task screen**:
A STARbase page that walks someone through one job, such as registering a sample or printing labels.

**Plotter**:
An interactive view that plots a run's recorded data. The **Force plotter** plots machining-force
captures; the **FAST plotter** plots sintering runs.
_Avoid_: dashboard (for these), plotting app

**Force App**:
The separate desktop app that records machining-force captures at the rig. It also contains a
copy of the Force plotter.
_Avoid_: force dashboard

**Data Studio**:
Directus's own admin interface: the forms, bulk tables, filter builder and admin settings. It has
no pages of the group's own; STARbase links to it, or embeds its form, instead of rebuilding those.
_Avoid_: Directus admin, the backend

**Permanent link**:
An address on the database server for a record or a STARbase page, which forwards to wherever
STARbase lives. Everything printed or linked from the database side uses one, so moving STARbase
never breaks it.
_Avoid_: permalink, QR link, deep link

### Navigation

**Page**:
Any STARbase destination a person can go to: Home, an index page, a record page, a task screen or a
plotter.
_Avoid_: route, slug, module, link

**Saved view**:
An index page with a named, saved filter, search and layout, owned by one person or shared with their
role or the whole group.
_Avoid_: bookmark, preset, filter

**Pin**:
A person's own shortcut to an index page, saved view, task screen, plotter or record, kept in the order
they choose. There is one pin per thing per person: pinning it on Home and in the sidebar is the same act.
_Avoid_: favourite, star, bookmark

**Section**:
One of the sidebar's top-level groups of pages: Records, Analysis, Inventory, Reference, More.
_Avoid_: module, tab, category

**Inventory**:
The section for the physical things the lab holds and uses up: tools, tool boxes, cutting inserts, insert
edges, raw stock lots.
_Avoid_: Kit, stock

**Reference**:
The section for the lab's reference data that records point to: equipment, materials, machine operators,
insert types, ISO classes, methods, manufacturers, facilities, prep recipes, etchants, FAST recipes.
_Avoid_: Resources, lookups, master data, Kit

### Samples and their history

**Process map**:
The STARbase page that shows how samples came to be: the samples, the operations and tests they went
through, and what was used in each (machine, tool, insert edge, recipe, data). Samples flow left to
right through the operations.
_Avoid_: lineage graph, node graph, connections graph, graph

**Lineage**:
The parent → child link between two samples: a sample cut from, sintered from, powder from or
derived from another. Lineage is only ever between samples.
_Avoid_: genealogy (the table's name), ancestry, lineage graph (for the page)

**Batch**:
Several operations, or several tests, done together as one job on several samples (four quarters
polished in one run). Each sample still has its own operation or test record; the batch is what ties
them together. A batch someone recorded is a **batch**; a group the process map only guesses (several pieces
cut from one sample on one day, or several samples polished, heat-treated or built together on one
day) is a **probable batch**, and is shown as such.
_Avoid_: run (a FAST run is one operation), group, set; and "batch" for a FAST run, even though the
FAST press calls it that

**FAST run**:
One press cycle on the FAST (spark plasma sintering) machine: one operation, one disc.
_Avoid_: batch, FAST batch, cycle

**Powder batch**:
The powder a FAST run used, as typed on the FAST press ("TIMET 45-150"). Many runs share one. It
names a raw stock lot but is only text: it is not linked to the lot.
_Avoid_: batch (on its own), FAST batch, batch number

## Relationships

- **STARbase** contains **Home**, the **index pages**, the **record pages**, the **task screens**
  and the **plotters**.
- A **record page** opens **Data Studio**'s form to edit its record.
- The **Force plotter** in **STARbase** and the one in the **Force App** are the same component.
- Report QR codes, label redirects and the **Force App** reach **STARbase** through a **permanent link**.

- A **saved view** belongs to exactly one **index page**.
- A **pin** points at one page, saved view or record. A pin to something the person can no longer see
  is kept but not shown.

## Flagged ambiguities

- "The frontend", "the head" and "the Explorer" were all used for this app; "Home" was used both
  for the landing page and for the whole Directus module that once hosted the app. Resolved: the
  app is **STARbase** ("Explorer" was its working name), and **Home** is only its landing page.
- "Kit" grouped both consumables and reference data, and "Tools" was both a sidebar section and an
  inventory index page. Resolved: the sections are **Inventory** and **Reference**, and the old "Tools"
  section is **More**.
- Pins on Home ("Frequently used") and pins in the sidebar were heading towards two different ideas.
  Resolved: one **pin**.
- "Lineage graph" named both the parent → child links between samples and the page that drew them
  with everything else. Resolved: **lineage** is only the link between samples; the page is the
  **process map**.
- "Batch" meant both the FAST press's free-text "Batch" field (the old "Batch #" form field) and several
  samples done together. Resolved: one press cycle is a **FAST run**, the press's field is the **powder batch**
  it used, and a **batch** is only several samples done together.
