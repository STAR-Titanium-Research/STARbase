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

## What you see

Since ADR-0011 a member sees only the records they are involved in. You can see a record when:

- you **own** it, or (for a sample) **co-own** it;
- you are **PI or investigator** of its project, which also covers what belongs to that project
  through its campaigns (read-only);
- you **own a campaign**: its samples, operations and tests are visible to you; and you can see a
  campaign when you own or co-own a sample in it;
- it is an **operation or test** on a sample you can see.

The pages show exactly that, so **counts are yours, not the lab's**: Home's *At a glance*, a
project's tiles and the Projects index count the records you can see, and a project you only touch
through one sample shows only that sample. A campaign's *Samples* count can be lower than its card
when some of its samples are not yours to see; the page then says *N samples not visible to you*.
A related record you may not see is shown as *not visible to you* (a breadcrumb, an operation's
input or output sample, a test's subject) instead of as empty, and a record you may not see at all
opens *Not found or not visible to you*. The *Project items* list on the project's Content form (the
roll-up) is for its PI and investigators only; anyone else gets a line saying so.

**Edit** is offered only where you may change the record: a sample's owner or co-owners, an
operation's or test's owner or an owner or co-owner of the sample it acts on, the owner of a
campaign, the PI of a project. If you can read a record because you are an investigator, or because
it sits in your campaign, the **Edit** button is not shown. On a campaign you do not own, the sample
picker is hidden (adding a sample needs the campaign's owner), with a note that operations and tests
are moved by their own owner. The operation and test pickers stay, because moving an operation or
test in or out of a campaign is a change to that operation or test, not to the campaign. If a
change is refused anyway, the page words it in plain words: the owner-only refusals of the access
guard (*Only the sample's owner can hand it to someone else.*), or, for Directus's own refusal, *Only
the owner or a co-owner can change this record.* (*Only the campaign's owner can change it.* for a
campaign, *Only the project's PI can change it.* for a project, *Only the owner of OP-12 (or of its
sample) can move it.* for an operation or test in a campaign picker). To let a colleague work
on a sample, add them as a co-owner. Linking a login to a person (the People page) is for
administrators only, and so is the audit log. The rules are in
[Roles and permissions](roles-and-permissions.md#who-can-see-and-change-which-records).
Administrators see everything.

If your login is not linked to a People row you own nothing: *Register a sample* refuses up front,
and Home says so. Ask an administrator to link it.

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
If the server refuses the save, the drawer says who may change the record. Fields your role may
not read are left out. *New* records (a new operation, test or project) still
open the Content form.
