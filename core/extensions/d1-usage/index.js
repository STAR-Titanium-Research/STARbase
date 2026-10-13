// Directus endpoint: d1-usage  (mounted at /d1-usage)
//
// The server half of the Explorer Home "Frequently used" panel (spec
// docs/superpowers/specs/2026-10-12-explorer-frequently-used-design.md, migration 163).
//
//   POST /d1-usage/visit {kind: 'page'|'record', target}   -> 204   adds weight 1 (3 for action:* pages)
//   GET  /d1-usage                                          -> { pages: Item[], records: Item[] }
//        Item = { target, score, pinned, last_at }; score is decayed to now; at most 15 per list,
//        by decayed score; hidden items, pinned items (they live in the sidebar) and view rows left out.
//   POST /d1-usage/pin   {kind: 'page'|'view'|'record', target, pinned: boolean}
//                                                           -> 204   creates the row when missing; a new pin
//                                                                    goes last, an unpin closes the gap
//   POST /d1-usage/hide  {kind, target}                     -> 204   (also unpins)
//   POST /d1-usage/clear                                    -> 204   drops unpinned rows, zeroes pinned ones
//
// Sidebar (spec docs/superpowers/specs/2026-10-13-explorer-sidebar-b2-design.md, migration 165):
//   GET  /d1-usage/nav                                      -> { pins: [{kind, target}], prefs: {...} }
//        every pinned row of every kind in pin_order; prefs as stored (the client fills defaults). The first
//        call of a person (user_prefs.pins_seeded false) pins samples and projects (appended after any pins
//        they already have, each only if not yet pinned) and sets pins_seeded, in the same transaction: once.
//   POST /d1-usage/pin-order {items: [{kind, target}]}      -> 204, or 409 {error: 'pins changed'} when items
//        are not exactly the person's current pins (so a stale tab cannot drop a pin); nothing changes then.
//   POST /d1-usage/prefs {sidebarCollapsed?, autoCollapse?, theme?}
//                                                           -> 204   merged into user_prefs.prefs; an empty
//        body, an unknown key or a wrong type is a 400 and writes nothing
//   POST /d1-usage/pins/reset                               -> 204   unpins everything, then pins samples (0)
//        and projects (1); pins_seeded is set
// pin_order is gapless from 0 across all of a person's pins, whatever their kind; NULL when not pinned.
//
// Every route needs a signed-in user (401 otherwise) and reads or writes only that user's rows
// (accountability.user). The rows live in d1_private (never a Directus collection), so this endpoint
// is the only way to them. All SQL is parameterised; nothing the client sends is put into SQL text.
// A client-supplied target is untrusted: only a known page key, or "<one of seven collections>:<id>",
// passes validTarget (kind view: a saved view's preset id, a positive integer); anything else is a 400
// and nothing is written.
//
// Scores: a stored score is stated "as of last_at" and fades with a half-life of 10 days:
//   score * 0.5^(dt / 10 days) + weight     (on write; decay() does the same on read)
// so no nightly job is needed. A use that is OLDER than last_at (the activity fold meets edits made
// before a later visit) is added at its own faded weight and leaves last_at alone: see bump().
//
// Activity fold (GET): the user's directus_activity rows (create/update on the seven record
// collections) since their cursor are counted as weight 3 each, at most 500 rows per call. The cursor
// advance and the score updates share one transaction, and every write transaction first takes a
// per-user advisory lock, so two requests of one user (two open tabs) never fold the same rows twice.

const HALF_LIFE_MS = 10 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOLD_LIMIT = 500;
const FIRST_FOLD_LOOKBACK_DAYS = 30;
// directus_activity ids are taken when a row is inserted but only become visible when its transaction
// commits, so a short scan may move the cursor only past rows old enough to be committed by now.
const FOLD_SAFETY_LAG_MS = 5 * 60 * 1000;
const LIST_LIMIT = 15;
// A faded score below this is dropped from the list (an unpinned item last used ~2 months ago).
const MIN_SCORE = 0.01;
const MAX_TARGET_LENGTH = 200;
// A saved view's id is a directus_presets id: a positive 32-bit integer.
const MAX_VIEW_ID = 2147483647;
// The pins a person gets once, in this order (and again from pins/reset).
const DEFAULT_PINS = [
    { kind: 'page', target: 'samples' },
    { kind: 'page', target: 'projects' },
];

export const WEIGHT_VISIT = 1;
export const WEIGHT_ACTION = 3; // quick action opened (target action:*)
export const WEIGHT_EDIT = 3; // create/update from directus_activity

// The seven collections whose records can be "used". Real names, checked against db/migrations:
// the tests collection is test_sessions; people and equipment are the lab's own tables.
export const RECORD_COLLECTIONS = [
    'physical_samples',
    'manufacturing_operations',
    'test_sessions',
    'campaigns',
    'projects',
    'people',
    'equipment',
];

// The page keys a client may ping. One literal list on purpose: the Explorer kit (packages/d1-ui,
// usage.ts) keeps a copy and a drift test reads THIS FILE as text and compares the two, so keep one
// quoted key per line and add keys here only (then in usage.ts: its test says what is missing).
// Each key is a real destination the Explorer pings: an index page's slug (/home/<slug>, every
// INDEX_DEFS entry plus the bespoke projects and people pages), a dashboard module's id (without its
// d1- prefix), or a quick action (action:*, weight 3). Saved views ("My samples") are bookmarks of the
// samples page, not pages of their own, so they have no key.
export const PAGE_KEYS = new Set([
    'campaigns',
    'samples',
    'operations',
    'tests',
    'tools',
    'tool-boxes',
    'inserts',
    'edges',
    'stock-lots',
    'equipment',
    'materials',
    'machine-operators',
    'insert-types',
    'iso-classes',
    'methods',
    'manufacturers',
    'facilities',
    'prep-recipes',
    'etchants',
    'fast-recipes',
    'projects',
    'people',
    'force-dashboard',
    'fast-dashboard',
    'action:register-sample',
    'action:log-operation',
    'action:print-labels',
]);

const toMs = (t) => (t instanceof Date ? t.getTime() : new Date(t).getTime());

// A score stated at lastAt, faded to now. Never grows (a lastAt in the future counts as now).
export function decay(score, lastAt, now) {
    const dt = Math.max(0, toMs(now) - toMs(lastAt));
    return score * 0.5 ** (dt / HALF_LIFE_MS);
}

// Add a use of `weight` at time `at` to a stored {score, last_at} (null = a new row).
// The result is stated as of the later of last_at and at, so last_at never moves backwards.
export function bump(prev, weight, at) {
    const a = toMs(at);
    if (!prev) return { score: weight, last_at: new Date(a) };
    const l = toMs(prev.last_at);
    if (a >= l) return { score: decay(prev.score, l, a) + weight, last_at: new Date(a) };
    return { score: prev.score + decay(weight, a, l), last_at: new Date(l) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// kind 'page': a known page key. kind 'record': "<collection>:<id>", id a lower-case uuid (all seven
// collections have uuid keys). kind 'view': a preset id as text, a positive integer without leading zeros.
// Anything else (wrong type, too long, unknown) is false.
export function validTarget(kind, target) {
    if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_LENGTH) return false;
    if (kind === 'page') return PAGE_KEYS.has(target);
    if (kind === 'record') {
        const i = target.indexOf(':');
        if (i < 1) return false;
        const id = target.slice(i + 1);
        return RECORD_COLLECTIONS.includes(target.slice(0, i)) && UUID.test(id);
    }
    if (kind === 'view') return /^[1-9][0-9]{0,9}$/.test(target) && Number(target) <= MAX_VIEW_ID;
    return false;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const usageWeight = (kind, target) => (kind === 'page' && target.startsWith('action:') ? WEIGHT_ACTION : WEIGHT_VISIT);

// Exported so the schema tests (tests/phase1_schema.sh) can run these exact statements against Postgres.
export const SQL = {
    lock: 'SELECT pg_advisory_xact_lock(hashtextextended(?::text, 0))',
    getRow:
        'SELECT score, last_at, pinned, hidden_at FROM d1_private.user_usage'
        + ' WHERE user_id = ? AND kind = ? AND target = ?',
    upsertRow:
        'INSERT INTO d1_private.user_usage (user_id, kind, target, score, last_at, pinned, hidden_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT (user_id, kind, target) DO UPDATE SET score = EXCLUDED.score,'
        + ' last_at = EXCLUDED.last_at, pinned = EXCLUDED.pinned, hidden_at = EXCLUDED.hidden_at',
    listRows:
        'SELECT kind, target, score, last_at, pinned FROM d1_private.user_usage'
        + " WHERE user_id = ? AND kind <> 'view' AND pinned = false AND (hidden_at IS NULL OR last_at > hidden_at)",
    getCursor: 'SELECT last_activity_id FROM d1_private.user_usage_cursor WHERE user_id = ?',
    setCursor:
        'INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES (?, ?)'
        + ' ON CONFLICT (user_id) DO UPDATE SET last_activity_id = EXCLUDED.last_activity_id',
    // The newest activity row older than the cutoff (the first fold's start, and the fold's safe cursor
    // limit): walks the primary key backwards.
    startId: 'SELECT id FROM directus_activity WHERE "timestamp" < ? ORDER BY id DESC LIMIT 1',
    maxId: 'SELECT id FROM directus_activity ORDER BY id DESC LIMIT 1',
    // "user" is quoted: a bare user is the SQL keyword (the current database role), not the column.
    activity:
        'SELECT id, collection, item, "timestamp" FROM directus_activity'
        + " WHERE \"user\" = ? AND id > ? AND action IN ('create', 'update')"
        + ` AND collection IN (${RECORD_COLLECTIONS.map(() => '?').join(', ')})`
        + ` ORDER BY id LIMIT ${FOLD_LIMIT}`,
    deleteUnpinned: 'DELETE FROM d1_private.user_usage WHERE user_id = ? AND pinned = false',
    zeroPinned: 'UPDATE d1_private.user_usage SET score = 0 WHERE user_id = ? AND pinned = true',
    // -- sidebar pins and preferences (migration 165) --
    // The person's pins, every kind, in order (the tie-break only matters for rows the order has not reached).
    getPins:
        'SELECT kind, target FROM d1_private.user_usage WHERE user_id = ? AND pinned = true'
        + ' ORDER BY pin_order, kind, target',
    // Bindings: user, user, kind, target. Gives a pinned row without an order the place after the last one.
    pinAppend:
        'UPDATE d1_private.user_usage SET pin_order = (SELECT coalesce(max(pin_order), -1) + 1'
        + ' FROM d1_private.user_usage WHERE user_id = ? AND pin_order IS NOT NULL)'
        + ' WHERE user_id = ? AND kind = ? AND target = ? AND pin_order IS NULL',
    clearPinOrder: 'UPDATE d1_private.user_usage SET pin_order = NULL WHERE user_id = ? AND kind = ? AND target = ?',
    // Closes gaps: 0, 1, 2 ... in the existing order. Bindings: user, user.
    compactPins:
        'UPDATE d1_private.user_usage u SET pin_order = r.n FROM (SELECT kind, target,'
        + ' row_number() OVER (ORDER BY pin_order, kind, target) - 1 AS n FROM d1_private.user_usage'
        + ' WHERE user_id = ? AND pin_order IS NOT NULL) r'
        + ' WHERE u.user_id = ? AND u.kind = r.kind AND u.target = r.target',
    // Bindings: position, user, kind, target.
    setPinOrder: 'UPDATE d1_private.user_usage SET pin_order = ? WHERE user_id = ? AND kind = ? AND target = ? AND pinned = true',
    unpinAll:
        'UPDATE d1_private.user_usage SET pinned = false, pin_order = NULL'
        + ' WHERE user_id = ? AND (pinned = true OR pin_order IS NOT NULL)',
    getPrefs: 'SELECT pins_seeded, prefs FROM d1_private.user_prefs WHERE user_id = ?',
    markSeeded:
        'INSERT INTO d1_private.user_prefs (user_id, pins_seeded) VALUES (?, true)'
        + ' ON CONFLICT (user_id) DO UPDATE SET pins_seeded = true, updated_at = now()',
    // Bindings: user, the new keys as JSON text. Merged into the stored prefs, not replacing them.
    setPrefs:
        'INSERT INTO d1_private.user_prefs (user_id, prefs) VALUES (?, ?::jsonb)'
        + ' ON CONFLICT (user_id) DO UPDATE SET prefs = d1_private.user_prefs.prefs || EXCLUDED.prefs,'
        + ' updated_at = now()',
};

// The preference keys a client may store, each with its check.
export const PREF_KEYS = {
    sidebarCollapsed: (v) => typeof v === 'boolean',
    autoCollapse: (v) => typeof v === 'boolean',
    theme: (v) => v === 'system' || v === 'light' || v === 'dark',
};
const PIN_KINDS = ['page', 'view', 'record'];

const rowsOf = (out) => out?.rows ?? [];

// The module's whole logic, mountable with a clock so tests can move time.
export function mount(router, { database, logger }, clock = () => new Date()) {
    // One transaction per write, serialised per user by an advisory lock (released at commit).
    const inTx = (user, fn) =>
        database.transaction(async (trx) => {
            await trx.raw(SQL.lock, [user]);
            return fn(trx);
        });

    const getRow = async (trx, user, kind, target) =>
        rowsOf(await trx.raw(SQL.getRow, [user, kind, target]))[0] ?? null;
    const putRow = (trx, user, kind, target, r) =>
        trx.raw(SQL.upsertRow, [user, kind, target, r.score, r.last_at, r.pinned, r.hidden_at ?? null]);

    // Pin order: the last place for a pin without one, and closing the gap when one is dropped.
    const appendPin = (trx, user, kind, target) => trx.raw(SQL.pinAppend, [user, user, kind, target]);
    const dropPin = async (trx, user, kind, target) => {
        await trx.raw(SQL.clearPinOrder, [user, kind, target]);
        await trx.raw(SQL.compactPins, [user, user]);
    };
    // Pin a page (keeping what it earned, un-hiding it), unless it is pinned already.
    const pinPage = async (trx, user, kind, target, now) => {
        const row = await getRow(trx, user, kind, target);
        if (row?.pinned) return;
        await putRow(trx, user, kind, target, {
            score: row?.score ?? 0,
            last_at: row?.last_at ?? now,
            pinned: true,
            hidden_at: null,
        });
        await appendPin(trx, user, kind, target);
    };
    const pinsOf = async (trx, user) =>
        rowsOf(await trx.raw(SQL.getPins, [user])).map((r) => ({ kind: r.kind, target: r.target }));

    // Routes: require a signed-in user, hand the handler its user id, turn failures into a 500.
    const route = (fn) => async (req, res) => {
        const user = req.accountability?.user;
        if (!user) return res.status(401).json({ error: 'authentication required' });
        try {
            return await fn(req, res, user);
        } catch (e) {
            logger.error(`d1-usage: ${e?.message || e}`);
            return res.status(500).json({ error: 'usage unavailable' });
        }
    };

    // A body with a valid {kind, target}, or null after answering 400.
    const targetOf = (req, res) => {
        const b = req.body;
        if (isObject(b) && validTarget(b.kind, b.target)) return b;
        res.status(400).json({
            error: 'kind must be page, view or record, and target a known page key, a view id or <collection>:<id>',
        });
        return null;
    };

    router.post('/visit', route(async (req, res, user) => {
        const b = targetOf(req, res);
        if (!b) return undefined;
        const now = clock();
        await inTx(user, async (trx) => {
            const row = await getRow(trx, user, b.kind, b.target);
            const next = bump(row, usageWeight(b.kind, b.target), now);
            // Using it again is what un-hides it.
            await putRow(trx, user, b.kind, b.target, { ...next, pinned: row?.pinned ?? false, hidden_at: null });
        });
        return res.status(204).end();
    }));

    router.post('/pin', route(async (req, res, user) => {
        const b = targetOf(req, res);
        if (!b) return undefined;
        if (typeof b.pinned !== 'boolean') return res.status(400).json({ error: 'pinned must be true or false' });
        const now = clock();
        await inTx(user, async (trx) => {
            const row = await getRow(trx, user, b.kind, b.target);
            await putRow(trx, user, b.kind, b.target, {
                score: row?.score ?? 0,
                last_at: row?.last_at ?? now,
                pinned: b.pinned,
                hidden_at: b.pinned ? null : (row?.hidden_at ?? null),
            });
            if (b.pinned) await appendPin(trx, user, b.kind, b.target);
            else await dropPin(trx, user, b.kind, b.target);
        });
        return res.status(204).end();
    }));

    router.post('/hide', route(async (req, res, user) => {
        const b = targetOf(req, res);
        if (!b) return undefined;
        const now = clock();
        await inTx(user, async (trx) => {
            const row = await getRow(trx, user, b.kind, b.target);
            await putRow(trx, user, b.kind, b.target, {
                score: row?.score ?? 0,
                last_at: row?.last_at ?? now,
                pinned: false, // hiding something pinned removes it
                hidden_at: now,
            });
            await dropPin(trx, user, b.kind, b.target);
        });
        return res.status(204).end();
    }));

    // The first nav call gives the default pins, once (pins_seeded), after any the person already has.
    router.get('/nav', route(async (_req, res, user) => {
        const now = clock();
        const out = await inTx(user, async (trx) => {
            let prefs = rowsOf(await trx.raw(SQL.getPrefs, [user]))[0] ?? null;
            if (!prefs?.pins_seeded) {
                for (const p of DEFAULT_PINS) await pinPage(trx, user, p.kind, p.target, now);
                await trx.raw(SQL.markSeeded, [user]);
            }
            const stored = prefs?.prefs;
            prefs = typeof stored === 'string' ? JSON.parse(stored) : (stored ?? {});
            return { pins: await pinsOf(trx, user), prefs };
        });
        return res.json(out);
    }));

    router.post('/pin-order', route(async (req, res, user) => {
        const items = isObject(req.body) ? req.body.items : undefined;
        const wellFormed = Array.isArray(items)
            && items.every((i) => isObject(i) && PIN_KINDS.includes(i.kind) && validTarget(i.kind, i.target));
        if (!wellFormed) return res.status(400).json({ error: 'items must be a list of {kind, target}' });
        const done = await inTx(user, async (trx) => {
            // Exactly the current pins, once each; anything else is a stale tab.
            const current = await pinsOf(trx, user);
            const id = (i) => `${i.kind}\u0000${i.target}`;
            const want = new Set(items.map(id));
            if (want.size !== items.length || items.length !== current.length || !current.every((c) => want.has(id(c)))) {
                return false;
            }
            for (const [n, i] of items.entries()) await trx.raw(SQL.setPinOrder, [n, user, i.kind, i.target]);
            return true;
        });
        if (!done) return res.status(409).json({ error: 'pins changed' });
        return res.status(204).end();
    }));

    router.post('/prefs', route(async (req, res, user) => {
        const b = req.body;
        const keys = isObject(b) ? Object.keys(b) : [];
        if (keys.length === 0 || !keys.every((k) => Object.hasOwn(PREF_KEYS, k) && PREF_KEYS[k](b[k]))) {
            return res.status(400).json({
                error: 'body must hold sidebarCollapsed (boolean), autoCollapse (boolean) or theme (system, light or dark)',
            });
        }
        const next = Object.fromEntries(keys.map((k) => [k, b[k]]));
        await inTx(user, (trx) => trx.raw(SQL.setPrefs, [user, JSON.stringify(next)]));
        return res.status(204).end();
    }));

    router.post('/pins/reset', route(async (_req, res, user) => {
        const now = clock();
        await inTx(user, async (trx) => {
            await trx.raw(SQL.unpinAll, [user]);
            for (const p of DEFAULT_PINS) await pinPage(trx, user, p.kind, p.target, now);
            await trx.raw(SQL.markSeeded, [user]);
        });
        return res.status(204).end();
    }));

    router.post('/clear', route(async (_req, res, user) => {
        await inTx(user, async (trx) => {
            await trx.raw(SQL.deleteUnpinned, [user]);
            await trx.raw(SQL.zeroPinned, [user]);
            // Move the cursor to the present, or the next GET would fold the last 30 days back in.
            const top = rowsOf(await trx.raw(SQL.maxId))[0];
            await trx.raw(SQL.setCursor, [user, top?.id ?? 0]);
        });
        return res.status(204).end();
    }));

    // Count the user's new create/update activity since their cursor (see the header).
    async function fold(user, now) {
        await inTx(user, async (trx) => {
            const cur = rowsOf(await trx.raw(SQL.getCursor, [user]))[0];
            let cursor;
            if (cur) {
                cursor = Number(cur.last_activity_id);
            } else {
                const cutoff = new Date(toMs(now) - FIRST_FOLD_LOOKBACK_DAYS * DAY_MS);
                cursor = Number(rowsOf(await trx.raw(SQL.startId, [cutoff]))[0]?.id ?? 0);
            }
            // The newest activity id older than the safety lag: a short scan may move the cursor there (a
            // quiet user then never rescans old rows) but no further, because a newer id may belong to a
            // write of this user's that is still uncommitted (a long import) and would be skipped for good.
            const safeCutoff = new Date(toMs(now) - FOLD_SAFETY_LAG_MS);
            const newest = Number(rowsOf(await trx.raw(SQL.startId, [safeCutoff]))[0]?.id ?? 0);
            const acts = rowsOf(await trx.raw(SQL.activity, [user, cursor, ...RECORD_COLLECTIONS]));
            // Group by target, oldest first, so each row is read and written once.
            const byTarget = new Map();
            let last = cursor;
            for (const a of acts) {
                last = Math.max(last, Number(a.id));
                const target = `${a.collection}:${a.item}`;
                if (!validTarget('record', target)) continue;
                if (!byTarget.has(target)) byTarget.set(target, []);
                byTarget.get(target).push(new Date(a.timestamp));
            }
            for (const [target, times] of byTarget) {
                const row = await getRow(trx, user, 'record', target);
                let next = row;
                for (const at of times) next = bump(next, WEIGHT_EDIT, at);
                await putRow(trx, user, 'record', target, {
                    score: next.score,
                    last_at: next.last_at,
                    pinned: row?.pinned ?? false,
                    hidden_at: row?.hidden_at ?? null,
                });
            }
            // A full page (FOLD_LIMIT rows) means there may be more: stay at the last row read. A short
            // page has read everything up to `newest` (the last folded row counts too), so skip the user's
            // non-matching rows as well.
            if (acts.length < FOLD_LIMIT) last = Math.max(last, newest);
            if (!cur || last !== cursor) await trx.raw(SQL.setCursor, [user, last]);
        });
    }

    router.get('/', route(async (_req, res, user) => {
        const now = clock();
        // A broken fold (say, directus_activity unreadable) must not hide the scores already earned.
        try {
            await fold(user, now);
        } catch (e) {
            logger.warn(`d1-usage: activity fold failed: ${e?.message || e}`);
        }
        const rows = rowsOf(await database.raw(SQL.listRows, [user]));
        const items = rows
            .map((r) => ({
                kind: r.kind,
                target: r.target,
                score: decay(Number(r.score), r.last_at, now),
                pinned: Boolean(r.pinned),
                last_at: new Date(r.last_at).toISOString(),
            }))
            .filter((r) => r.pinned || r.score >= MIN_SCORE)
            .sort((a, b) => (Number(b.pinned) - Number(a.pinned))
                || (b.score - a.score)
                || (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0)
                || (a.target < b.target ? -1 : 1));
        const list = (kind) => items
            .filter((r) => r.kind === kind)
            .slice(0, LIST_LIMIT)
            .map(({ target, score, pinned, last_at }) => ({ target, score, pinned, last_at }));
        return res.json({ pages: list('page'), records: list('record') });
    }));
}

export default {
    id: 'd1-usage',
    handler: (router, context) => mount(router, context),
};
