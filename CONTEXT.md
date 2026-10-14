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
A STARbase page about a single Project, Campaign, Sample, Operation, Test, Tool box, Cutting insert or
Insert edge.
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

### Records and forms

**Sample**:
A physical piece of material the lab makes, cuts or tests. The rows Data Studio lists as items are
Samples, except the rig kit stored with them (see Flagged ambiguities).
_Avoid_: Item, physical sample, workpiece (except as the input of an Operation)

**Field group**:
A headed block of fields inside a Data Studio form, such as "Geometry" or "Who & where". Some are
folded away until opened ("Related records", "Legacy / system").
_Avoid_: section (the sidebar's word), panel, part

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

### People and access

**Person**:
Anyone attributed on a record: a researcher, an operator, or both. A person may or may not have a login.
_Avoid_: user, account, member (for this)

**Login**:
The means of signing in to STARbase. A login belongs to at most one person; a person may have none.
_Avoid_: user, account

**Researcher** / **Operator**:
What kind of work a person does; a person can be both. Never called a role.
_Avoid_: role, type

**Former**:
A person who has left the group. Their records and history stay; being Former changes nothing else by itself.
_Avoid_: inactive, archived, deleted

**Suspended**:
A login that can no longer sign in. Independent of Former.
_Avoid_: disabled, deactivated, Former

**Account role**:
What a login may administer: Administrator, Lab Admin or Lab Member. Only an Administrator changes one.
_Avoid_: role (alone), permission, user role

**Access level**:
What one person or team may do with one record: Can view, Can edit or Owner; on a project, Investigator or
Principal investigator in their place.
_Avoid_: role, permission, share type

**Owner**:
Who decides who has access to a record and may transfer or restrict it: a person, or a team for a sample,
campaign, operation or test. A project's owner is its principal investigator, always a person.
_Avoid_: creator, author

**Restricted**:
A record visible only to its owner, the people and teams listed on it, and admins; it hides everything under it.
_Avoid_: private, hidden, locked

**Team**:
A named set of people, visible to everyone, that can be given an access level on a record or own one. A team
cannot sign in and never acts by itself.
_Avoid_: group (that is the STAR group as a whole), team account, role

**Team manager**:
A team member who may add and remove members and name other managers. For a record the team owns, the team's
managers act as its owner.
_Avoid_: team owner, team admin

**Pending member**:
A team member whose access to one record shared with the team waits for that record's owner, because they joined
after it was shared and joining would raise their access to it.
_Avoid_: invited, requested

**Trust future members**:
A choice on one record's team entry: people who join the team later get that record's access level without the
owner approving them.
_Avoid_: auto-approve, open team
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

### Tooling

**Tool box**:
A box of cutting inserts of one insert type, as the lab received and stores it. Its inserts are numbered
in the box.
_Avoid_: insert box

**Cutting insert**:
One indexable insert from a tool box, named by its number in that box.
_Avoid_: tip, tool

**Insert edge**:
One cutting edge of a cutting insert, the unit a test or operation is run with. It is named by an
**edge letter**.
_Avoid_: corner, cutting edge (for the record)

**Edge letter**:
The letter that says where an edge sits on its insert. Letters run clockwise from the insert's
reference mark: the top face first (A, B, …), then the underside (C, D, …) on a double-sided insert,
with C directly under A. Only corners that can cut get a letter. Old edges named `fA`, `fC` use the same
letters; the `f` means nothing. When the insert type's edge count is lower than its cutting corners,
only that many corners get letters, from A.

**Tipped insert**:
A cutting insert whose cutting edge is a brazed tip of a superhard material (PCD, PCBN), usually one per
insert and sold one insert per box. Each tip is one insert edge.
_Avoid_: PCD box (for the insert), diamond insert

## Relationships

- **STARbase** contains **Home**, the **index pages**, the **record pages**, the **task screens**
  and the **plotters**.
- A **record page** opens **Data Studio**'s form to edit its record.
- The **Force plotter** in **STARbase** and the one in the **Force App** are the same component.
- Report QR codes, label redirects and the **Force App** reach **STARbase** through a **permanent link**.

- A **saved view** belongs to exactly one **index page**.
- A **tool box** holds **cutting inserts** of one insert type; each **cutting insert** has one
  **insert edge** per edge letter. An edge is used or fresh; an insert is depleted when it is used up.
- A **pin** points at one page, saved view or record. A pin to something the person can no longer see
  is kept but not shown.

- A **person** has at most one **login**; a **login** has one **account role**.
- A **team** has one or more **team managers**; its members are **people**, never other teams.
- A record has exactly one **owner** and any number of people and teams with an **access level**; someone's
  access is the highest level any path gives them.
- Removing someone from a **team** takes its access away at once; adding someone gives access only where the
  owner **trusts future members** or approves them.

## Flagged ambiguities

- "The frontend", "the head" and "the Explorer" were all used for this app; "Home" was used both
  for the landing page and for the whole Directus module that once hosted the app. Resolved: the
  app is **STARbase** ("Explorer" was its working name), and **Home** is only its landing page.
- "Kit" grouped both consumables and reference data, and "Tools" was both a sidebar section and an
  inventory index page. Resolved: the sections are **Inventory** and **Reference**, and the old "Tools"
  section is **More**.
- Pins on Home ("Frequently used") and pins in the sidebar were heading towards two different ideas.
  Resolved: one **pin**.
- "Role" meant the login's Directus role, the access level on a record, team manager vs member, and
  researcher vs operator. Resolved: **account role**, **access level**, **team manager**, and
  **Researcher** / **Operator** (never "role").
- "Group", "team" and "team account" were used for a set of people given access together. Resolved: a
  **team**, which is not an account; "group" means the STAR group.
- "Lineage graph" named both the parent → child links between samples and the page that drew them
  with everything else. Resolved: **lineage** is only the link between samples; the page is the
  **process map**.
- "Batch" meant both the FAST press's free-text "Batch" field (the old "Batch #" form field) and several
  samples done together. Resolved: one press cycle is a **FAST run**, the press's field is the **powder batch**
  it used, and a **batch** is only several samples done together.
- "Item" and "Sample" were both used for the same records, whose Item Type also allowed Equipment and
  Miscellaneous; the 16 Equipment rows are rig kit (dyno, cases, hand tools). Resolved: the record is a
  **Sample**. The rig kit belongs in **Inventory**; that move is not made yet.
