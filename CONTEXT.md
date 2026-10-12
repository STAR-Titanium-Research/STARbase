# D1-Database — Context

The lab's database for samples, the operations done to them and the tests run on them, and the
people and projects behind that work.

## Language

### The Explorer

**Explorer**:
The lab's own web app for reading, finding and moving between records. It is also the home of
the lab's plotters. It reads, finds and navigates; creating and editing a record is done with
**Data Studio**'s form.
_Avoid_: frontend, head, lab-web, d1-home

**Home**:
The Explorer's landing page: the lab view for everyone, and the admin overview for administrators.

**Index page**:
An Explorer page that lists the records of one kind, with search and a few fixed filters.
_Avoid_: list view, collection page

**Record page**:
An Explorer page about a single Project, Campaign, Sample, Operation or Test.
_Avoid_: detail page, item page

**Task screen**:
An Explorer page that walks someone through one job, such as registering a sample or printing labels.

**Plotter**:
An interactive view that plots a run's recorded data. The **Force plotter** plots machining-force
captures; the **FAST plotter** plots sintering runs.
_Avoid_: dashboard (for these), plotting app

**Force App**:
The separate desktop app that records machining-force captures at the rig. It also contains a
copy of the Force plotter.
_Avoid_: force dashboard

**Data Studio**:
Directus's own admin interface: the forms, bulk tables, filter builder and admin settings. The
Explorer links to it, or embeds its form, instead of rebuilding those.
_Avoid_: Directus admin, the backend

## Relationships

- The **Explorer** contains **Home**, the **index pages**, the **record pages**, the **task screens**
  and the **plotters**.
- A **record page** opens **Data Studio**'s form to edit its record.
- The **Force plotter** in the **Explorer** and the one in the **Force App** are the same component.

## Flagged ambiguities

- "The frontend" and "the head" were used for the Explorer; "Home" was used both for the landing
  page and for the whole Directus module that hosts the Explorer today. Resolved: the app is the
  **Explorer**, and **Home** is only its landing page.
