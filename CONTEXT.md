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
_Avoid_: list view, collection page

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

## Relationships

- **STARbase** contains **Home**, the **index pages**, the **record pages**, the **task screens**
  and the **plotters**.
- A **record page** opens **Data Studio**'s form to edit its record.
- The **Force plotter** in **STARbase** and the one in the **Force App** are the same component.
- Report QR codes, label redirects and the **Force App** reach **STARbase** through a **permanent link**.

## Flagged ambiguities

- "The frontend", "the head" and "the Explorer" were all used for this app; "Home" was used both
  for the landing page and for the whole Directus module that once hosted the app. Resolved: the
  app is **STARbase** ("Explorer" was its working name), and **Home** is only its landing page.
