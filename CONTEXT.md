# D1-Database — Context

The database of the STAR group (Sheffield Titanium Alloy Research) for samples, the operations
done to them and the tests run on them, and the people and projects behind that work.

## Language

### STARbase

**STARbase**:
The group's own web app for reading, finding and moving between records. It is also the home of
the lab's plotters. It reads, finds and navigates, and on the **process map** it builds processes and
fills their records in with its own form; elsewhere, creating and editing a record is done with
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

**Project**:
A named, usually funded piece of research with a principal investigator, dates and a document number.
It groups campaigns, and it can also hold samples, operations and tests directly, outside any campaign.
_Avoid_: programme, research campaign

**Campaign**:
One planned set of operations or tests on a set of samples within a project: a **machining trial** or a
**testing campaign**, with its own owner, dates and status (planned, active, complete, on hold).
_Avoid_: project (for this), study, trial (alone)

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
What a login may administer: Administrator, Lab Admin, Lab Member or Lab Viewer. Only an Administrator changes one.
_Avoid_: role (alone), permission, user role

**Lab Viewer**:
The account role that reads everything and changes nothing: a login with it is a reader of every record,
Restricted ones included, and may create, edit, share, transfer or delete none, nor anything on the People
and Teams pages. It sees what a Lab Member sees, with every record on top, and on the People page what an
administrator sees (everyone's access, read-only, no control), and never writes.
_Avoid_: guest, read-only user, observer

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

**Stack of passes**:
Several operations of the same method on the same machine, done one after another on one sample with
nothing else in between (twelve turning passes), drawn as one container that can be unstacked. Each pass
is still its own operation.
_Avoid_: batch (a batch is done together on several samples; passes are done in turn on one), group

### Building on the process map

**Card**:
One record drawn on the process map on its own: a sample, a raw stock lot, a material.
_Avoid_: node, box

**Container**:
An operation or a test (or a batch of them) drawn as a box that samples enter and leave, with what
was used inside it.
_Avoid_: node, operation card

**Socket**:
The round connector on the edge of a card or container where a wire starts or ends: inputs on the
left, outputs on the right. A card or container shows a socket for each wire it has plus one free one;
a spare socket nobody uses is not kept.
_Avoid_: node, port, handle, pin (a pin is a shortcut)

**Wire**:
The line from an output socket to an input socket. A wire carries one sample.
_Avoid_: edge, link, connection

**Edit mode**:
The process map's mode for building a process: adding cards and containers, wiring them and filling
them in. A blank canvas is edit mode with nothing on it yet.
_Avoid_: builder, node editor (for the mode)

**Palette**:
The side list of everything that can be added to the canvas: a sample, an operation by method, a test,
a template. Each entry is dragged onto the canvas, onto a socket, or onto a wire.
_Avoid_: toolbox, menu (the add search is the keyboard route to the same list)

**Add search**:
The type-to-search list that opens at the pointer (Shift+A or Ctrl/⌘+K) and offers what the palette
offers, filtered to what fits where it was opened.
_Avoid_: command palette, add menu

**Insert**:
To put an operation between the two ends of a **wire** (drop it on the wire), or before or after the
selected card (I and Shift+I). One undoable step, and never on a wire of done records. A done sample
is never given a new parent: **Add an earlier step** starts a new planned chain upstream of it instead.
_Avoid_: splice, re-parent

**Remove** / **Delete** / **Dissolve**:
**Remove** takes a new or planned card, container or wire off the canvas; a planned record that was
already created is deleted when the draft is created. **Delete** is the key that removes the selection.
**Dissolve** removes a container and wires its input straight to its output. A done record can be
neither removed nor dissolved.
_Avoid_: hide, cut

**Draft**:
What someone has built in edit mode and not yet created. A draft is kept for its owner automatically,
survives closing the page, and has a name; a person can have several. Nothing in a draft is a record
until it is created, and then all of it is at once, or none of it.
_Avoid_: plan (a planned operation is a record), sketch, unsaved changes

**Create**:
Turning a draft into records, all together. It is refused while anything the records need is missing.
_Avoid_: save (a draft is kept without saving), commit, publish

**Planned** / **Done**:
An operation or test is **planned** when it has been laid out but not carried out yet, and **done**
once someone marks it done, saying when and who. Both are real records; a draft is neither. A sample an
operation is planned to make is a **planned sample** until that operation is done.
_Avoid_: draft (for a planned record), pending, scheduled

**Attach**:
To wire an operation that is already recorded to a sample in edit mode, making that sample its input.
Not for files: tying a file to a record is to **link** it.
_Avoid_: import

**New from**:
To start a new operation as a copy of an existing one (same method, machine, tool and settings) and
change what differs.
_Avoid_: duplicate (that copies what is on the canvas), template (that is saved, not a record), clone, import

**Duplicate**:
To copy a card or container already on the canvas, with everything filled in on it, one or several times.
Duplicating an in-place operation adds further passes to the same sample.
_Avoid_: clone, copy-paste

**Template**:
A named, saved set of prefilled fields for a new operation or test (method, machine, tool, operator,
settings), not tied to any record. It belongs to one person or is shared with their role or the whole
group. Changing a template never changes what was made from it. A template may point to a recipe but
is not one. It is made with **Save as template** on any operation or test (never the sample, the dates
or whether it is done; notes only when asked), is the first group of the **palette** and the **add
search**, and is used by dropping or choosing it: the new container starts with its values and is not
linked to it.
_Avoid_: preset, recipe (a FAST or prep recipe is reference data), saved operation

**Checks**:
The list of what a draft is missing before it can be created, or a planned record before it can be
marked done. Some entries block; the rest only warn.
_Avoid_: supervisor (a person), validator, readiness

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

### Surface scans

**Surface scan**:
One topography file (an Alicona scan, say) of one **cutting insert** or one **insert edge**, kept with the
**condition** the item was in and, when known, the date and the operation that wore it. It shows on the
insert's or edge's page as a 3D view. It is not a test.
_Avoid_: Alicona test (for a tool edge), scan test, attachment

**Condition**:
The state a **surface scan** found its insert or edge in: new, worn, cleaned or other, with a note.
_Avoid_: status, wear state

**Add a surface scan**:
To put a topography file on an insert or edge as a **surface scan**, from the file library or from a
**found file** in the **inbox**. Adding it makes the file visible to every lab member, as the insert and edge
are. It is the one verb for these files; **link** is for samples, operations and tests.
_Avoid_: attach (that is the process map's word), link (for an insert or edge)

### Files on the share

**Personal folder**:
A person's own folder under `Users` on the lab's file share, named by their **uni alias**.
_Avoid_: home folder, user folder

**Uni alias**:
The short university username that names a person's **personal folder**. It is kept on the person, and an
administrator sets it.
_Avoid_: username (that is the login's), user ID

**Team folder**:
A folder under `Shared` on the file share that an administrator has tied to a **team**.
_Avoid_: shared folder (all of `Shared` is that), group folder

**Found file**:
A file spotted in a **personal folder** or **team folder** that nobody has **linked** or dismissed yet. It
may be tagged with what it looks like (an SEM image, say) and with the record it seems to belong to.
_Avoid_: candidate, new file, upload

**Inbox**:
The **found files** waiting for one person, or for one team, to **link** or dismiss.
_Avoid_: queue, notifications

**Backlog**:
The **found files** that were already in a folder when the crawler first looked. They are not counted as
new, and those that clearly belong to a record are flagged.
_Avoid_: old files, legacy files

**Link**:
To tie a file on the share to a sample, operation or test, so it shows on that record's page. A link can
be undone; linking never changes, moves or deletes the file.
_Avoid_: attach (that is the process map's word), upload, import

**SEM image**:
An image recognised as coming from a scanning electron microscope, whether it is still a **found file** or
already **linked**.
_Avoid_: micrograph (the lab says SEM image)

**Data bar**:
The strip along the bottom edge of an **SEM image** that prints the microscope's settings and the scale bar.
_Avoid_: footer, banner, info bar

**Imaging settings**:
What was read from an **SEM image**: accelerating voltage, working distance, magnification, spot size,
detector, mode, scale bar, the date it was taken and the instrument. They describe one image, never a whole
**test**.
_Avoid_: SEM parameters (parameters are a **test**'s), metadata

**Provenance owner**:
The person whose **personal folder** a file came from, or the team whose **team folder** it came from. Only the
**provenance owner** can see that file and its **imaging settings**, and only they can **link** it. It is fixed
when the file is first registered and follows the person, not the **uni alias**'s spelling. Administrators can
see such files read-only.
_Avoid_: uploader, creator, folder owner

**Locked file**:
A file **linked** to a record someone can read, but whose **provenance owner** is somebody else. They see that
the link exists and nothing about the file: no name, no **imaging settings**, no contents.
_Avoid_: private file, hidden file

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

- A **personal folder** belongs to one **person** (by **uni alias**) and a **team folder** to one **team**;
  a **found file** goes to the **inbox** of the person or team whose folder it is in.

- A **surface scan** belongs to exactly one **cutting insert** or one **insert edge**, and an edge's page also
  shows its insert's scans. A **surface scan** is never a **test**: an Alicona test on the surface of a
  **sample** stays a test.

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
- "Node" was used for the socket on a card ("press the free node on the sample") as well as for the cards
  and containers themselves. Resolved: the connector is a **socket**, the line a **wire**, the boxes
  **cards** and **containers**; "node" names none of them.
- "Import an existing operation" meant both wiring an already-recorded operation to a sample and starting
  a new operation from an existing one. Resolved: the first is **attach**, the second **new from**.
- "Supervisor" was asked for as the thing that shows what a draft is missing, but in the lab a supervisor
  is a person. Resolved: that list is **checks**.
- The database described projects as "research campaigns / projects", so a project and a campaign read as
  one thing. Resolved: a **project** is the research and its funding, and it holds **campaigns**. A
  campaign is one planned set of operations or tests inside a project.
- "Attach" was used both for wiring an operation to a sample on the process map and for tying a file on the
  share to a record. Resolved: the first stays **attach**; the second is **link**, and a file nobody has
  linked yet is a **found file**.
- "Template" was used both for starting from an existing operation and for a saved, reusable set of
  prefilled fields. Resolved: the first is **new from**, the second a **template**; copying what is
  already on the canvas is **duplicate**.
- A topography scan of a tool edge was filed as a test with the edge as its subject, which mixed inspecting
  tool wear with characterising samples (SEM, EBSD, Alicona of a machined surface). Resolved: a scan of an
  insert or edge is a **surface scan**, and an Alicona test on a sample stays a **test**. A **surface scan**
  is **added**, while **link** stays the verb for samples, operations and tests.
