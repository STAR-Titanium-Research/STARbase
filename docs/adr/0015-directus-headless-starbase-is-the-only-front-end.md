# ADR-0015: Directus goes headless and STARbase is the only front end

- **Status:** Proposed (2026-10-13)
- **Date:** 2026-10-13
- **Deciders:** Maintainer + Claude (headless interview,
  [spec](../superpowers/specs/2026-10-13-directus-headless-design.md))
- **Amends:** [ADR-0013](./0013-starbase-separate-tailnet-device-shared-directus-session.md). STARbase
  no longer runs beside the Directus Home module; it replaces it.

STARbase went live on 2026-10-13 and does everything the Directus `d1-home` module does. Directus
now loses **every custom page** that STARbase duplicates or will absorb: Home, the Force and FAST
plotters, the lab dashboard, the crawler panel and Ask. It keeps what a headless CMS needs, plus what
STARbase depends on:
- Data Studio's built-in modules;
- the form-only edit page STARbase frames;
- the field interfaces that render inside that form;
- the endpoints and the hooks.

Anything Directus prints or links to the front end goes through **one permanent link on the
Directus host**, `/d1-links/go/…`, which redirects to `STARBASE_URL`. This covers:
- report QR codes and in-report links;
- the label redirects;
- the Force App's "open record";
- the module bar's STARbase tile;
- the record links in Data Studio interfaces.

## Considered options

- **Keep running both front ends** (ADR-0013's starting position). Rejected: two copies of every
  page to build, test and redeploy, with nothing gained now that STARbase is live.
- **Point printed links straight at STARbase.** Rejected: printed codes would break the day
  STARbase moves, is renamed or is replaced. d1-server is the system of record and outlives any
  front end.
- **Point printed links at Data Studio's record forms.** Rejected: it sends people into raw forms,
  against the point of going headless.
- **Remove the field interfaces as well (fully headless).** Rejected: STARbase edits through
  Directus's form, and the interfaces are part of that form.
- **Hide Data Studio from Lab Members.** Not possible in Directus 11, which has one module bar for
  everyone. Lab Members also need app access for the framed form to load.

## Consequences

- `STARBASE_URL` becomes required. With it unset, the permanent links answer `503`, not a dead
  Home-module path.
- The permanent links are public and read nothing from the database, so a phone scanning a QR
  code reaches STARbase's sign-in. Their target origin is fixed, so they cannot become an open
  redirect.
- Removing an extension from git is not enough on live. Directus mounts `core/extensions` as it is,
  and a removed extension's git-ignored `dist/` stays loaded until it is deleted by hand.
- `@d1/starbase-pages` keeps its host seam with only one page host left. The seam is kept on
  purpose: it is cheap, and it keeps a second host possible.
- If the tailnet name ever changes, both hosts change together. Only a custom domain would protect
  printed codes from that.
