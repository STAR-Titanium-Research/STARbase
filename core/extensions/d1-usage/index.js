// Directus endpoint: d1-usage  (mounted at /d1-usage)
//
// The server half of the Explorer Home "Frequently used" panel (spec
// docs/superpowers/specs/2026-10-12-explorer-frequently-used-design.md, migration 163).
//
//   POST /d1-usage/visit {kind: 'page'|'record', target}   -> 204   adds weight 1 (3 for action:* pages)
//   GET  /d1-usage                                          -> { pages: Item[], records: Item[] }
//        Item = { target, score, pinned, last_at }; score is decayed to now; at most 15 per list,
//        pinned first, then by decayed score; hidden items left out.
//   POST /d1-usage/pin   {kind, target, pinned: boolean}    -> 204   creates the row when missing
//   POST /d1-usage/hide  {kind, target}                     -> 204   (also unpins)
//   POST /d1-usage/clear                                    -> 204   drops unpinned rows, zeroes pinned ones
//
// Every route needs a signed-in user (401 otherwise) and reads or writes only that user's rows
// (accountability.user). The rows live in d1_private (never a Directus collection), so this endpoint
// is the only way to them. All SQL is parameterised; nothing the client sends is put into SQL text.
// A client-supplied target is untrusted: only a known page key, or "<one of seven collections>:<id>",
// passes validTarget; anything else is a 400 and nothing is written.
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
const LIST_LIMIT = 15;
// A faded score below this is dropped from the list (an unpinned item last used ~2 months ago).
const MIN_SCORE = 0.01;
const MAX_TARGET_LENGTH = 200;

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
// quoted key per line and add keys here only (the d1-home task extends this same list).
// Route slugs are the Explorer's (/home/<slug>); action:* are quick actions (weight 3).
export const PAGE_KEYS = new Set([
    'home',
    'samples',
    'my-samples',
    'operations',
    'tests',
    'campaigns',
    'projects',
    'people',
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
    'register-sample',
    'force-dashboard',
    'fast-dashboard',
    'fast-runs',
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
const INT_ID = /^[1-9][0-9]{0,17}$/;

// kind 'page': a known page key. kind 'record': "<collection>:<id>", id a lower-case uuid or a
// positive integer as text. Anything else (wrong type, too long, unknown) is false.
export function validTarget(kind, target) {
    if (typeof target !== 'string' || target.length === 0 || target.length > MAX_TARGET_LENGTH) return false;
    if (kind === 'page') return PAGE_KEYS.has(target);
    if (kind === 'record') {
        const i = target.indexOf(':');
        if (i < 1) return false;
        const id = target.slice(i + 1);
        return RECORD_COLLECTIONS.includes(target.slice(0, i)) && (UUID.test(id) || INT_ID.test(id));
    }
    return false;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const usageWeight = (kind, target) => (kind === 'page' && target.startsWith('action:') ? WEIGHT_ACTION : WEIGHT_VISIT);

const SQL = {
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
        + ' WHERE user_id = ? AND (hidden_at IS NULL OR last_at > hidden_at)',
    getCursor: 'SELECT last_activity_id FROM d1_private.user_usage_cursor WHERE user_id = ?',
    setCursor:
        'INSERT INTO d1_private.user_usage_cursor (user_id, last_activity_id) VALUES (?, ?)'
        + ' ON CONFLICT (user_id) DO UPDATE SET last_activity_id = EXCLUDED.last_activity_id',
    // The newest activity row older than the cutoff: walks the primary key backwards.
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
};

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
        res.status(400).json({ error: 'kind must be page or record, and target a known page key or <collection>:<id>' });
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
