// Directus endpoint: d1-admin-overview  (mounted at /d1-admin-overview)
//
// GET /d1-admin-overview  ->  {
//   missingFiles: { count, recent: [{ id, filename_download, missing_since }] },   (<= 10, newest first)
//   fingerprints: { done, error, missing },
//   crawler: { state: { desired_state, current_activity, last_heartbeat_at, processed_count, error_count } | null,
//              analyses: { pending, processing, done, error } },
//   ownerless: { samples, campaigns, machiningOperations },
// }
//
// The counts behind the admin Home panels. directus_files.metadata is a json column, which Directus
// cannot filter over REST, hence SQL here. Admin only: 401 without a signed-in user, 403 for anyone
// who is not an admin. Each part is read on its own and fails soft (null, and a warning in the log),
// so one broken query does not take the other panels down.
//
// Ownerless operations counts machining (non-sintering) operations only: the thousands of legacy FAST
// imports will never get an owner and would swamp the panel.

const toCount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

// Rows of {status, n} -> an object with every wanted status present (0 when absent).
function byStatus(rows, statuses) {
    const out = Object.fromEntries(statuses.map((s) => [s, 0]));
    for (const row of rows ?? []) {
        if (Object.prototype.hasOwnProperty.call(out, row.status)) out[row.status] = toCount(row.n);
    }
    return out;
}

const count = async (database, sql) => toCount((await database.raw(sql))?.rows?.[0]?.n);

const MISSING = "(metadata::jsonb->>'missing') = 'true'";

export default {
    id: 'd1-admin-overview',
    handler: (router, { database, logger }) => {
        const parts = {
            async missingFiles() {
                const n = await count(database, `SELECT count(*)::int AS n FROM directus_files WHERE ${MISSING}`);
                const list = await database.raw(
                    "SELECT id, filename_download, metadata::jsonb->>'missing_since' AS missing_since"
                        + ` FROM directus_files WHERE ${MISSING}`
                        + " ORDER BY metadata::jsonb->>'missing_since' DESC NULLS LAST LIMIT 10",
                );
                const recent = (list?.rows ?? []).map((r) => ({
                    id: r.id,
                    filename_download: r.filename_download ?? null,
                    missing_since: r.missing_since ?? null,
                }));
                return { count: n, recent };
            },

            async fingerprints() {
                const zeros = { done: 0, error: 0, missing: 0 };
                // The table comes from migration 159: an older database has none.
                const reg = await database.raw("SELECT to_regclass('public.file_fingerprints') AS t");
                if (!reg?.rows?.[0]?.t) return zeros;
                const out = await database.raw(
                    'SELECT status, count(*)::int AS n FROM file_fingerprints GROUP BY status',
                );
                return byStatus(out?.rows, Object.keys(zeros));
            },

            async crawler() {
                const st = await database.raw(
                    'SELECT desired_state, current_activity, last_heartbeat_at, processed_count, error_count'
                        + ' FROM force_crawler_state LIMIT 1',
                );
                const row = st?.rows?.[0] ?? null;
                const state = row && {
                    desired_state: row.desired_state ?? null,
                    current_activity: row.current_activity ?? null,
                    last_heartbeat_at: row.last_heartbeat_at ?? null,
                    processed_count: toCount(row.processed_count),
                    error_count: toCount(row.error_count),
                };
                const an = await database.raw(
                    'SELECT status, count(*)::int AS n FROM machining_force_analysis GROUP BY status',
                );
                return {
                    state,
                    analyses: byStatus(an?.rows, ['pending', 'processing', 'done', 'error']),
                };
            },

            async ownerless() {
                const [samples, campaigns, machiningOperations] = await Promise.all([
                    count(database, 'SELECT count(*)::int AS n FROM physical_samples WHERE owner_person_id IS NULL'),
                    count(database, 'SELECT count(*)::int AS n FROM campaigns WHERE owner_person_id IS NULL'),
                    count(
                        database,
                        'SELECT count(*)::int AS n FROM manufacturing_operations WHERE owner_person_id IS NULL'
                            + " AND (process_category IS NULL OR process_category <> 'sintering')",
                    ),
                ]);
                return { samples, campaigns, machiningOperations };
            },
        };

        router.get('/', async (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) {
                return res.status(401).json({ error: 'authentication required' });
            }
            if (!acc.admin) {
                return res.status(403).json({ error: 'forbidden' });
            }
            const out = {};
            await Promise.all(
                Object.entries(parts).map(async ([name, read]) => {
                    try {
                        out[name] = await read();
                    } catch (e) {
                        logger.warn(`d1-admin-overview: ${name}: ${e?.message || e}`);
                        out[name] = null;
                    }
                }),
            );
            // Keep the documented key order whatever order the parts finished in.
            return res.json({
                missingFiles: out.missingFiles,
                fingerprints: out.fingerprints,
                crawler: out.crawler,
                ownerless: out.ownerless,
            });
        });
    },
};
