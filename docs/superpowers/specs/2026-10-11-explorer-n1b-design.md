# N1b: richer navigation, index-page views and an admin Home

Status: **decisions taken by the maintainer on 2026-10-11** (answers Q1-Q6 to the mockup
`explorer-round2b.html` in the session folder). Builds after L1 (rail and panels), on top of
`feat/explorer-rail`. The implementation plan comes after L1 is done.

Why: after seeing N1 in a preview the maintainer found the sidebar "too simplistic, flat and messy",
wanted direct access to plots from lists, a picture-led view for small sets and hunting, a density
option, and an admin Home without half-empty panels of different heights.

## Decisions

1. **Sidebar: option B, an icon rail plus a panel.** *(Superseded on 2026-10-13 by
   [the B2 sidebar spec](2026-10-13-explorer-sidebar-b2-design.md): one sidebar with an accordion,
   a collapsed icon rail, pins and settings.)* A dark icon rail picks a section (Home,
   Records, Analysis, Kit = inventory and resources, Tools); the panel beside it shows only that
   section's lists, with the open list's saved views under it. The Explorer will run as its own site
   on the tailnet, so the second icon bar next to Directus's module bar is temporary. (The "Recent"
   box of option A was not chosen.)
2. **Row plot buttons.** On Operations rows: a **Force** button only when the operation has a
   finished force analysis (`machining_force_analysis.status = 'done'`; 177 of 236 machining
   operations on live), a **FAST** button only when it has a FAST run trace; each opens
   `/d1-force-dashboard?operation=<id>` / `/d1-fast-dashboard?operation=<id>`. On Samples rows a
   **Force (n)** button when the sample has n operations with force data; it opens the Operations
   index filtered to that sample's operations with force data. (The FAST dashboard reads
   `?operation=` only once at mount; reopening it on another operation needs a reload or a fix there.)
3. **Card view on every list.** A Table / Cards switch on all index pages, remembered per list in the
   browser. Picture cards where there is a picture:
   - samples: an image linked to the sample if any, else the **geometry drawing**, which must look
     exactly as on the Sample page (one shared renderer and stylesheet for the page, the thumbnail
     and the report; the drawing's CSS classes travel with it);
   - machining operations: the force figure (Fz map) as a resized, lazily loaded thumbnail
     (`/assets/<id>?width=320&height=…&fit=cover`; the originals are ~19 MB PNGs);
   - equipment, tools, insert types, manufacturers: their photo or logo.
   Lists without pictures get **text cards**. **Campaigns get a designed card like the Projects
   card** (code, name, type, status, dates, progress, counts).
   Samples have no image field today (AppSheet photos were never migrated: only equipment, tools and
   insert types were); adding one and importing the AppSheet photos waits on the maintainer pointing
   to `Sample_Data.xlsx` / the AppSheet image folder.
4. **Density:** Compact / Normal / Roomy, remembered per list per browser; Roomy adds a thumbnail
   column where the list has pictures.
5. **Admin Home:** one stats band across the top; quick actions in the greeting; "Needs attention"
   lists only non-zero items (one ✓ line otherwise); the three "mine" panels become one "Your work"
   panel showing only parts with content; panels in a row stretch to equal height; recent activity
   full width. **Admin panels:** the force-crawler queue (state, pending/processing/error counts,
   last heartbeat), files missing on the share (`directus_files` flagged missing by the indexer;
   `file_fingerprints.status = 'missing'`), and ownerless records (samples/operations/campaigns with
   no owner). The L1 spec's two Home density fixes are folded in here.
6. **Order:** L1 first, then N1b.
