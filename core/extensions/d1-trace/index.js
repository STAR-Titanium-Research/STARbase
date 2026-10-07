// Directus endpoint: d1-trace  (mounted at /d1-trace)
//
// GET /d1-trace/sample/:id  ->  the sample's cradle-to-grave story:
//   { sample, stock_origins[], ancestors[], events[], descendants[], hidden{}, truncated{} }
//
// The four traceability functions (db/migrations/20260619000014_traceability.sql; the two genealogy
// walks are plpgsql since 20261006000136) run as the database owner, so they ignore Directus
// permissions. This endpoint uses them only to find WHICH records are related (ids, depth, which
// node each was reached from). Every value it returns
// (codes, forms, labels, dates, status, relationship type, fraction, mass) is then read through
// Directus's ItemsService with req.accountability, so a record the caller cannot read is dropped
// and only counted, and a field the role cannot read is simply absent. A sample the caller cannot
// read is a 404 (the same as a missing one). Design:
// docs/superpowers/specs/2026-10-06-sample-timeline-and-campaign-overview-design.md
//
// f_trace_ancestors / f_trace_descendants return one row per reachable sample, with one shortest
// path (migration 20261006000136). The statement deadline below stays as defence in depth for
// pathological data.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-section cap so a pathological genealogy cannot produce an unbounded response. SQL asks for
// one more than this to know whether it was cut.
const MAX_ROWS = 500;
// ids per readByQuery `_in`, to keep the SQL parameter list small; pairs per `_or` filter.
const CHUNK = 200;
const PAIR_CHUNK = 100;
// One deadline for all the statements of one request together: each gets what is left of it, so the
// four of them cannot hold a pooled connection for 4x as long.
const TRACE_TIMEOUT_MS = 8000;

// One row per distinct sample reached (a diamond A->B, A->C, B->D, C->D has D once, not twice), the
// shallowest depth it was reached at, and every reached node it is linked to on the way from the
// root (`prev`) so JS can tell whether any route to it avoids unreadable samples. The functions
// return a single shortest path per sample, so `prev` is rebuilt from the genealogy edges between
// the reached samples instead of from that one path: a sample with a readable alternative route is
// then not wrongly reported as hidden. `own` is the genealogy column holding the sample itself and
// `step` the one holding the node it was reached from (child for ancestors, parent for descendants).
// `prev` is ordered shallowest first, so the edge shown is from the nearest readable step (on cyclic
// data a back-edge from a deeper node is also in `prev`, but only as a fallback).
const lineageSql = (fn, own, step) => `
    WITH reached AS (SELECT sample_id, depth FROM ${fn}(?::uuid))
    SELECT r.sample_id, r.depth, array_agg(sg.${step} ORDER BY p.depth, sg.${step}) AS prev
    FROM reached AS r
    INNER JOIN sample_genealogy AS sg ON sg.${own} = r.sample_id
    INNER JOIN reached AS p ON p.sample_id = sg.${step}
    WHERE r.sample_id <> ?::uuid
    GROUP BY r.sample_id, r.depth
    ORDER BY r.depth, r.sample_id
    LIMIT ${MAX_ROWS + 1}`;
// A lot can reach the sample through several ancestors.
const STOCK_SQL = `
    SELECT via_sample_id, lot_id, min(depth) AS depth
    FROM f_trace_stock_origins(?::uuid)
    GROUP BY via_sample_id, lot_id
    ORDER BY min(depth), lot_id, via_sample_id
    LIMIT ${MAX_ROWS + 1}`;
// Newest events are kept when there are too many (undated ones go first), listed oldest first.
const EVENTS_SQL = `
    SELECT event_type, event_id, event_date FROM (
        SELECT event_type, event_id, event_date FROM f_sample_timeline(?::uuid)
        ORDER BY event_date DESC NULLS LAST, event_id
        LIMIT ${MAX_ROWS + 1}
    ) AS newest
    ORDER BY event_date ASC NULLS LAST, event_id`;

const isDenied = (err) => err?.code === 'FORBIDDEN' || err?.status === 403;

// Read through the caller's permissions. Fields are ['*'] on purpose: Directus then returns only
// the fields the role may read, whereas an explicit field list is refused outright if any listed
// field is restricted. Callers pick what they need from the rows, so a restricted field is absent.
// A forbidden collection reads as null ("nothing readable").
async function readRows({ ItemsService, accountability, schema }, collection, filter) {
    const items = new ItemsService(collection, { accountability, schema });
    try {
        return (await items.readByQuery({ filter, fields: ['*'], limit: -1 })) ?? [];
    } catch (err) {
        if (isDenied(err)) return null;
        throw err;
    }
}

// Rows of `collection` the caller may read, by primary key: Map pk -> row.
async function readById(ctx, collection, pk, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    for (let i = 0; i < unique.length; i += CHUNK) {
        const rows = await readRows(ctx, collection, { [pk]: { _in: unique.slice(i, i + CHUNK) } });
        if (rows === null) return new Map();
        for (const r of rows) if (r?.[pk]) out.set(r[pk], r);
    }
    return out;
}

// Rows of a table with a composite key, for the given [a, b] pairs: Map `a|b` -> row. Nothing
// readable (forbidden table, or key fields hidden from the role) gives an empty Map.
async function readByPairs(ctx, collection, [fa, fb], pairs) {
    const unique = [...new Map(pairs.map((p) => [p.join('|'), p])).values()];
    const out = new Map();
    for (let i = 0; i < unique.length; i += PAIR_CHUNK) {
        const filter = {
            _or: unique
                .slice(i, i + PAIR_CHUNK)
                .map(([a, b]) => ({ _and: [{ [fa]: { _eq: a } }, { [fb]: { _eq: b } }] })),
        };
        const rows = await readRows(ctx, collection, filter);
        if (rows === null) return new Map();
        for (const r of rows) if (r?.[fa] && r?.[fb]) out.set(`${r[fa]}|${r[fb]}`, r);
    }
    return out;
}

// Samples reachable from the root by walking only readable samples. `rows` are the distinct
// lineage rows ({ sample_id, prev[] }). A listed, readable sample that is NOT in the result can only
// be reached through an unreadable one, whichever path is taken. When the section was cut at
// MAX_ROWS (`truncated`), a step that is not among the rows is missing, not unreadable, and nothing
// is known about it: it is treated as walkable, so a row is never marked hidden because of it.
function reachable(rootId, rows, okSamples, truncated = false) {
    const next = new Map();
    for (const r of rows) {
        for (const p of r.prev ?? []) {
            if (!next.has(p)) next.set(p, []);
            next.get(p).push(r.sample_id);
        }
    }
    const seen = new Set([rootId]);
    const queue = [rootId];
    if (truncated) {
        const listed = new Set(rows.map((r) => r.sample_id));
        for (const p of next.keys()) {
            if (p !== rootId && !listed.has(p)) {
                seen.add(p);
                queue.push(p);
            }
        }
    }
    while (queue.length) {
        for (const c of next.get(queue.shift()) ?? []) {
            if (!seen.has(c) && okSamples.has(c)) {
                seen.add(c);
                queue.push(c);
            }
        }
    }
    return seen;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d instanceof Date ? d.toISOString() : (d ?? null));
const val = (v) => v ?? null;

// Directus-style error body, so the UI's errorText() (errors[0].message) shows it.
const fail = (res, status, code, message) => res.status(status).json({ errors: [{ message, extensions: { code } }] });

export default {
    id: 'd1-trace',
    handler: (router, { database, logger, services, getSchema }) => {
        router.get('/sample/:id', async (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) return fail(res, 401, 'INVALID_CREDENTIALS', 'authentication required');
            if (!(acc.admin || acc.app)) return fail(res, 403, 'FORBIDDEN', 'forbidden');
            const id = req.params?.id;
            if (typeof id !== 'string' || !UUID.test(id)) {
                return fail(res, 400, 'INVALID_PAYLOAD', 'id must be a sample_id (uuid)');
            }
            try {
                const ctx = {
                    ItemsService: services.ItemsService,
                    accountability: acc,
                    schema: req.schema ?? (await getSchema()),
                };

                // Root first: unreadable and missing look the same, and nothing else is queried.
                const rootRows = await readById(ctx, 'physical_samples', 'sample_id', [id]);
                const rootRow = rootRows.get(id);
                if (!rootRow) return fail(res, 404, 'ROUTE_NOT_FOUND', 'sample not found');

                // One transaction (SET LOCAL ends with it) and one deadline: before each statement the
                // timeout is set to the time left (at least 1 s), and an exhausted budget is the same
                // 503 as a statement that timed out.
                const [anc, desc, stock, events] = await database.transaction(async (trx) => {
                    const deadline = Date.now() + TRACE_TIMEOUT_MS;
                    const q = async (sql, bindings) => {
                        const left = deadline - Date.now();
                        if (left <= 0) throw Object.assign(new Error('trace deadline exhausted'), { code: '57014' });
                        await trx.raw(`SET LOCAL statement_timeout = ${Math.max(1000, Math.ceil(left))}`);
                        return (await trx.raw(sql, bindings))?.rows ?? [];
                    };
                    return [
                        await q(lineageSql('f_trace_ancestors', 'parent_sample_id', 'child_sample_id'), [id, id]),
                        await q(lineageSql('f_trace_descendants', 'child_sample_id', 'parent_sample_id'), [id, id]),
                        await q(STOCK_SQL, [id]),
                        await q(EVENTS_SQL, [id]),
                    ];
                });

                const truncated = {};
                const cap = (name, rows) => {
                    if (rows.length <= MAX_ROWS) return rows;
                    truncated[name] = true;
                    return rows.slice(0, MAX_ROWS);
                };
                const ancestors = cap('ancestors', anc);
                const descendants = cap('descendants', desc);
                const stockRows = cap('stock_origins', stock);
                // Events arrive oldest first with undated last, and SQL kept the newest MAX_ROWS + 1
                // (undated last in that ranking): drop the extra from the end if it is undated, else
                // the oldest at the front.
                let eventRows = events;
                if (eventRows.length > MAX_ROWS) {
                    truncated.events = true;
                    eventRows = eventRows.at(-1).event_date == null ? eventRows.slice(0, MAX_ROWS) : eventRows.slice(1);
                }

                // Everything is re-read through the caller's permissions, per collection.
                const sampleIds = new Set([id]);
                for (const r of [...ancestors, ...descendants]) sampleIds.add(r.sample_id);
                for (const r of stockRows) sampleIds.add(r.via_sample_id);
                const idsOf = (type) => eventRows.filter((e) => e.event_type === type).map((e) => e.event_id);
                const [samples, ops, tests, lots] = await Promise.all([
                    readById(ctx, 'physical_samples', 'sample_id', [...sampleIds]),
                    readById(ctx, 'manufacturing_operations', 'operation_id', idsOf('manufacturing_operation')),
                    readById(ctx, 'test_sessions', 'session_id', idsOf('test_session')),
                    readById(ctx, 'raw_stock_lots', 'lot_id', stockRows.map((r) => r.lot_id)),
                ]);
                const okSamples = new Set(samples.keys());

                const hidden = { stock_origins: 0, ancestors: 0, events: 0, descendants: 0 };

                // Lineage rows are distinct samples already. A row is "through hidden" when every path
                // to it passes an unreadable sample; the relationship edge (type, fraction) comes from
                // a readable step, so it is dropped for those rows.
                const lineage = async (name, rows, edgeFields) => {
                    const reach = reachable(id, rows, okSamples, !!truncated[name]);
                    const shown = [];
                    const edges = [];
                    for (const r of rows) {
                        if (!okSamples.has(r.sample_id)) {
                            hidden[name]++;
                            continue;
                        }
                        const through = !reach.has(r.sample_id);
                        const from = through ? null : (r.prev ?? []).find((p) => reach.has(p));
                        shown.push({ r, through, from });
                        // [fa, fb] order of edgeFields: (child, parent) for the genealogy table
                        if (from) edges.push(name === 'ancestors' ? [from, r.sample_id] : [r.sample_id, from]);
                    }
                    const edgeRows = await readByPairs(ctx, 'sample_genealogy', edgeFields, edges);
                    return shown.map(({ r, through, from }) => {
                        const s = samples.get(r.sample_id);
                        const e = from
                            ? edgeRows.get(name === 'ancestors' ? `${from}|${r.sample_id}` : `${r.sample_id}|${from}`)
                            : null;
                        return {
                            depth: Number(r.depth),
                            sample_id: r.sample_id,
                            sample_code: val(s.sample_code),
                            form: val(s.form),
                            relationship_type: val(e?.relationship_type),
                            fraction: num(e?.fraction),
                            through_hidden: through,
                        };
                    });
                };
                const edgeFields = ['child_sample_id', 'parent_sample_id'];
                const [ancestorOut, descendantOut] = await Promise.all([
                    lineage('ancestors', ancestors, edgeFields),
                    lineage('descendants', descendants, edgeFields),
                ]);

                // A lot reached through an ancestor chain that passes an unreadable sample is marked
                // the same way, so the UI can say the path is not fully visible.
                const ancReach = reachable(id, ancestors, okSamples, !!truncated.ancestors);
                const ancListed = new Set(ancestors.map((r) => r.sample_id));
                const readableStock = stockRows.filter((r) => lots.has(r.lot_id));
                const provenance = await readByPairs(
                    ctx,
                    'sample_stock_provenance',
                    ['sample_id', 'lot_id'],
                    readableStock.map((r) => [r.via_sample_id, r.lot_id]),
                );
                const hiddenLots = new Set(stockRows.filter((r) => !lots.has(r.lot_id)).map((r) => r.lot_id));
                hidden.stock_origins = hiddenLots.size;
                const stock_origins = readableStock.map((r) => {
                    const lot = lots.get(r.lot_id);
                    const via = samples.get(r.via_sample_id);
                    return {
                        lot_id: r.lot_id,
                        lot_code: val(lot.lot_code),
                        stock_type: val(lot.stock_type),
                        supplier_name: val(lot.supplier_name),
                        mass_used_grams: num(provenance.get(`${r.via_sample_id}|${r.lot_id}`)?.mass_used_grams),
                        via_sample_id: r.via_sample_id,
                        via_sample_code: via ? val(via.sample_code) : null,
                        depth: Number(r.depth),
                        // A via sample that was cut from a truncated ancestors list is unknown, not
                        // hidden: only its own readability counts then.
                        through_hidden:
                            truncated.ancestors && r.via_sample_id !== id && !ancListed.has(r.via_sample_id)
                                ? !okSamples.has(r.via_sample_id)
                                : !ancReach.has(r.via_sample_id),
                    };
                });

                const out = [];
                for (const e of eventRows) {
                    const isOp = e.event_type === 'manufacturing_operation';
                    const row = isOp ? ops.get(e.event_id) : e.event_type === 'test_session' ? tests.get(e.event_id) : null;
                    if (!row) {
                        hidden.events++;
                        continue;
                    }
                    // Only identifying fields are passed on; operator names and file pointers are
                    // deliberately left out.
                    out.push({
                        type: e.event_type,
                        collection: isOp ? 'manufacturing_operations' : 'test_sessions',
                        id: e.event_id,
                        date: iso(isOp ? row.operation_date : row.session_date),
                        label: val(isOp ? row.pass_code : row.test_type),
                        sequence: isOp ? num(row.operation_sequence) : null,
                        status: isOp ? null : val(row.status),
                    });
                }

                return res.json({
                    sample: { sample_id: id, sample_code: val(rootRow.sample_code), form: val(rootRow.form) },
                    stock_origins,
                    ancestors: ancestorOut,
                    events: out,
                    descendants: descendantOut,
                    hidden,
                    truncated,
                });
            } catch (e) {
                // 57014 = query_canceled, i.e. the statement_timeout above.
                if (e?.code === '57014') {
                    logger.warn?.(`d1-trace: genealogy of ${id} too large to trace within ${TRACE_TIMEOUT_MS} ms`);
                    return fail(res, 503, 'SERVICE_UNAVAILABLE', 'this sample\'s genealogy is too large to trace');
                }
                logger.error(`d1-trace: ${e?.message || e}`);
                return fail(res, 500, 'INTERNAL_SERVER_ERROR', 'could not read the sample timeline');
            }
        });
    },
};
