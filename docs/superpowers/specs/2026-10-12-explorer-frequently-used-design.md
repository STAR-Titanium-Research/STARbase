# U1 — "Frequently used" on Home (design)

Status: decisions agreed with the maintainer 2026-10-12; this spec awaits their review. Branch `feat/explorer-frequent`
(worktree `u1-frequent`), stacked on `feat/explorer-n1b` (#241), because the Home it adds to is N1b's.

## What the user gets

A **Frequently used** panel on Home, under the hero beside the stats band, holding two short lists:

- **Pages & actions**: Explorer pages and quick actions, e.g. "Samples", "My samples", "FAST runs", "Log an operation".
- **Records**: samples, operations, tests, campaigns, projects, people and equipment.

Each list shows 6 items; "Show more" opens up to 15. Pinned items come first (📌), then the rest by score. Each item
has × (hide) and a pin toggle; the panel menu has **Clear my history** (keeps pins).

A user with no history sees **Suggested** items instead of an empty box: Samples, Log an operation, Register a
sample, My samples. Real use replaces them as it builds up.

Only you see your list. Admins see only their own too; there is no lab-wide view.

## What counts as use (decision c)

| Event | Weight | Source |
|---|---|---|
| Visit an Explorer page or record | 1 | ping from the Explorer, repeats of the same target within 10 min ignored |
| Create or update a record | 3 | Directus's own activity log (also catches Data Studio edits) |
| Run a quick action (register, log, print) | 3 | ping from the Explorer when the action's form is opened |

Scores fade: half-life 10 days, so a month-old burst counts about an eighth. A score is stored with its last-use time
and decayed on write (`score · 0.5^(Δt/10d) + weight`) and on read, so nothing needs a nightly job.

## Data

Migration `20261012000163_user_usage.sql`:

```sql
CREATE TABLE d1_private.user_usage (
    user_id   uuid        NOT NULL REFERENCES directus_users(id) ON DELETE CASCADE,
    kind      text        NOT NULL CHECK (kind IN ('page', 'record')),
    target    text        NOT NULL,   -- page: route key ("samples", "action:log-operation");
                                      -- record: "<collection>:<id>"
    score     float8      NOT NULL DEFAULT 0,
    last_at   timestamptz NOT NULL DEFAULT now(),
    pinned    boolean     NOT NULL DEFAULT false,
    hidden_at timestamptz,            -- hidden until used again after this time
    PRIMARY KEY (user_id, kind, target)
);
CREATE TABLE d1_private.user_usage_cursor (
    user_id          uuid PRIMARY KEY REFERENCES directus_users(id) ON DELETE CASCADE,
    last_activity_id integer NOT NULL
);
```

It lives in `d1_private`, which Directus does not expose as a collection, so the rows are reachable only through the
endpoint below, never through the REST items API or the Data Studio.

## Endpoint `d1-usage` (Directus endpoint extension)

Every route requires a signed-in user and only ever touches `accountability.user`'s rows.

- `POST /d1-usage/visit {kind, target}`: adds weight 1 (or 3 for `action:*` targets). The target is validated as
  either a known page key or `<collection>:<id>` for one of the seven record collections; anything else gets 400.
- `GET /d1-usage`: first folds in the user's new `directus_activity` rows since their cursor (create/update on the
  seven collections, weight 3, at most 500 rows per call; the first call starts from 30 days back). Returns
  `{ pages: [...], records: [...] }`, each up to 15, ranked pinned-then-decayed-score, hidden items left out.
- `POST /d1-usage/pin {kind, target, pinned}`, `POST /d1-usage/hide {kind, target}`, `POST /d1-usage/clear`.

Records come back as `collection:id` only. The Home panel fetches their labels through the normal items API **as
the user**, so a record the user can no longer read simply fails to load and is dropped. The endpoint never reveals
a record the user cannot read.

## Explorer side

- `packages/d1-ui` gets the pure parts with tests: target keys from routes, the 10-minute repeat filter, and ranking
  and decay helpers (shared with the endpoint's tests by value).
- `d1-home` sends the visit pings from its router hook (fire-and-forget, failures ignored), and adds
  `home/FrequentlyUsed.vue` with its loader.
- The kit stays Directus-free (guard test), in line with the Explorer later becoming standalone.

## Out of scope

Lab-wide or admin analytics, recommendations across users, tracking outside the Explorer except the
activity-log edits.

## Testing

Endpoint node tests (auth, validation, decay maths, the activity fold, the cursor, the per-user isolation), kit
vitest, a schema test for the migration (round trip), and the Explorer preview as admin and as Lab Member.
