# Explorer pages

The **Explorer pages** are formatted pages for the main records, so that you can follow a piece of
work from a project down to one test without opening a Directus form. They live in the **Home**
module (`/admin/home/...`) and every record link on Home, on the dashboards and on the pages
themselves leads to them. Everything on them is read as **you**, so you only see what your role
may read; a record that does not exist and one you may not read look the same
(*Not found or not visible to you*, with a button back to Home).

| Page | Address | Reached from |
|---|---|---|
| [Projects index](#projects-index) | `/admin/home/projects` | Home → More → *Projects* |
| [Project](#project) | `/admin/home/projects/<id>` | a project card |
| [Campaign](#campaign) | `/admin/home/campaigns/<id>` | a campaign card, or a breadcrumb |
| [Sample](samples.md#the-sample-page) | `/admin/home/samples/<id>` | any sample code |
| [Operation](#operation) | `/admin/home/operations/<id>` | any pass code |
| [Test](#test) | `/admin/home/tests/<id>` | any test |

The breadcrumb at the top of a page (`Home › Project › Campaign › Sample`) is the way back up.
Every page has **Edit** (the [Edit drawer](#the-edit-drawer)) and **Data Studio**, which opens the
ordinary Content form of the record. Samples, operations and tests also have **Report** (a PDF). Pages show each part as a section
that loads on its own, so one part you may not read shows a short message and the others still
work. Lists show their first 200 rows and say when there are more.

## Projects index

A card per project: code, name, principal investigator, status (*Active* or *Inactive*), dates,
the number of campaigns and of samples, and a small chart of operations and tests per week over
the last 26 weeks. **Search** matches the code or the name; **My role** narrows to projects where
you are PI, investigator or either; **Status** to active or inactive ones. **New project** opens
the Content form.

The counts on a card are exact. The chart reads the newest records only; if the lab has more than
the page loads, a note says so. The sample count is the samples assigned to the project; the
[Project page](#project) also counts samples that only sit in one of its campaigns.

## Project

The header has the code, name, status, dates, the PI and the investigators, and **Edit** and
**Data Studio** (there is no *Report* for a project). Below it:

- **Tiles** for samples, operations, tests and campaigns. A record belongs to a project by its own
  *Project*, or, when that is empty, by the project of its campaign, so the tiles agree with the
  campaign cards. Samples also count when they are in one of the project's campaigns. A tile shows
  a dash when your role may not read that collection.
- **Campaigns** as cards with type, owner, status and a progress bar (*Force analysed n / m* for a
  machining trial, *Tests complete n / m* for a testing campaign).
- **Not in a campaign**: the project's samples, operations and tests that belong to no campaign.
- **Activity**: operations and tests per week, full width.
- **Equipment used**: the machines named on the project's operations, with how often.

## Campaign

The header shows the campaign code and name, its type, the project as a breadcrumb, the owner, the
status (for example *In progress*), dates and the default machine and material, with **Edit** and
**Data Studio** (there is no *Report* for a campaign either). Under it:

- **Progress**: counts of samples, operations and tests, with bars for force analysed, diagnostics
  built and tests complete.
- **Samples and steps**, the **matrix**: one row per sample, one column per step. A step is the
  operation with that sequence number and process (so the same step lines up across samples),
  followed by one column per test type. Each cell is a link to the operation or test, coloured by
  its state; hover for the state and any error text. The sample column stays put when the grid
  scrolls.

  | Cell | Meaning |
  |---|---|
  | green ✓ | force analysed (operation) or test processed / analysed |
  | blue ◷ | queued (operation) or test waiting to be processed |
  | amber … | being processed |
  | red ! | error, or test failed |
  | grey – | skipped, or test registered but not processed |
  | grey · | operation without a force file |
  | empty | the sample has no step there |

  A small dot in the corner of a cell shows the diagnostics build (green built, blue queued, amber
  building, red error). A *broken link* icon beside a sample means it has an operation or test in
  the campaign but is not in its sample list. The colours follow the light or dark theme.
- **Samples**, **Operations** and **Test sessions** lists with the pickers to add and remove
  records. Adding sets the record's campaign (and its project too, when it had none); two people
  adding the same record cannot both win, and the second sees "already in another campaign".

## Operation

The header has the pass code, the process (for example *Machining* or *FAST sintering*), the date,
owner, operator and machine, and the breadcrumb `Project › Campaign › Sample`. Sections:

- **Overview**: method, step number, capture software and frequency, the force file id.
- **Parameters**: the fields of that process (cutting parameters for machining, sintering
  parameters for FAST...) as labels with units. Only the fields that apply to the process show.
- **Samples**: the sample the operation worked on and the one it produced.
- **Force analysis** (machining) with each file's analysis and diagnostics state, error text and
  **View forces**; or **FAST run** with **View FAST**.
- **Files**: linked data files, and the old network-share paths with a copy button.

## Test

The header has the test type and date, the status badge (registered, processing, processed,
analysed, failed...) and the same breadcrumb. Sections:

- **Overview** and **Parameters**: the fields of that test type (tensile, hardness...) with units.
- **Subject**: the sample, or other thing, the test was made on. A test with several samples lists
  all of them.
- **Results**: the numbers the processing workers wrote, grouped by analysis (basic statistics,
  FFT...). A test that is not yet processed says so.
- **Files**.

## The Edit drawer

**Edit** opens a side drawer with the record's normal Directus form, with the same fields and the
same custom widgets (sample code, machine picker, geometry preview...) as Content. **Save** writes
the changes and the page refreshes behind the drawer; **Cancel** closes it. If someone else saved
the record while the drawer was open, you are warned and nothing is overwritten until you reload.
Fields your role may not read are left out. *New* records (a new operation, test or project) still
open the Content form.
