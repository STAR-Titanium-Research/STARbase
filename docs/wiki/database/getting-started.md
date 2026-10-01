# Getting started

[← D1 Database wiki](README.md)

## Signing in

Open the Directus address you were given (on the lab network, over Tailscale) and sign in with
your email and password. The Force App uses the same account.

![The Directus sign-in page](../images/database/login.png)

Accounts are created by an administrator (see [Roles](roles-and-permissions.md)). There is no
self-registration. **Forgot Password** only works if the server has email configured; otherwise
ask an administrator to reset it.

## The screen

![The Content module](../images/database/content.png)

From left to right:

1. **The module bar** (the dark rail). Each icon is a whole section:

   | Icon | Module | What it is |
   |---|---|---|
   | cube | **Content** | every collection (table) and its records |
   | people | **User Directory** | Directus user accounts |
   | folder | **File Library** | uploaded files and indexed archive files |
   | chart | **Insights** | Directus's own dashboards |
   | grid | **Lab Dashboard** | the D1 overview of samples, machining and FAST ([Dashboards](dashboards-and-reports.md#lab-dashboard)) |
   | line chart | **Force Analysis** | the machining force dashboard ([Force data](force-data.md)) |
   | gauge | **FAST Analysis** | sintering traces ([FAST sintering data](fast-data.md)) |
   | cog | **Settings** | data model, roles, policies (administrators only) |

   **Home**, **Force Crawler** and **Ask the Database** are also modules. They are reached from
   the Home page's tiles rather than the rail.

2. **The navigation panel**: in Content, the collections grouped into folders (*Inventory*,
   *Manufacturing Operations*, *Manufacturing Methods*…). Type in *Search Collection…* to find
   one.
3. **The main area**: a list of records (the *layout*) or one record's form.
4. **The sidebar** on the right: layout options, filters and export on a list; **Revisions**,
   **Comments** and **Shares** on a record. Directus 11 also puts its **AI Assistant** here.

## The Home page

![Home](../images/database/home.png)

**Home** is the landing page. It has quick actions (*Register a sample*, *Log an operation*,
*Ask the database*, *Manage people*, *Dashboards*, *Force Analysis*, *FAST Analysis*, *Force
Crawler*), counts of samples, machining operations, FAST runs, tests and campaigns, and the most
recent activity.

## Working with records

- **Open a collection** in Content. Records are listed with the columns the layout shows. Click a
  column header to sort, use the search box, or open **Filter** in the sidebar.
- **Open a record** by clicking its row. Fields are laid out in the form, and many are D1
  custom fields that fill themselves in (see [Samples](samples.md) and
  [Operations](operations-and-tests.md)).
- **Save** with the ✓ at the top right (or Ctrl+S). The arrow next to it offers *Save and
  stay*, *Save and create new* and *Save as copy*.
- **Revisions** in the sidebar show every saved version of the record and who made it, and can
  revert to one. Every change is also written to the database's own tamper-evident
  [audit log](roles-and-permissions.md#the-audit-log).
- **Comments** are for notes to colleagues about a record.
- **Export** a list from the sidebar's *Import / Export* (CSV, JSON, XLSX).

## Codes you will see everywhere

Records are shown by their human-readable code, never by their internal ID:

| Code | Example | Built from |
|---|---|---|
| Sample code | `101-AA-MF-2026-09-01` | sequence number · alloy code · method code · date made |
| Operation (pass) code | `101-AA-MF-2026-09-01-MT-R4-301.59MPM_0.15feed_0.1DoC` | sample code · operation subtype + sequence · cutting speed, feed, depth of cut |
| Edge code | `CNMF-1-1A` | box · insert number · edge letter |
| Project code | `DEMO-001` | assigned |
| Campaign code | `DEMO-001-T1` | entered by hand (free text) |

Sample, operation and edge codes are generated automatically and can be regenerated from the data at any time. See
[The data model](data-model.md#identifiers-and-codes).
