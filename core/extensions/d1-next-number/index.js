// Directus endpoint: d1-next-number  (mounted at /d1-next-number)
//
// GET /d1-next-number/sample[?exclude=<sample_id>]  ->  { next: 37 }
//
// The preview number shown by the Register sample page and the sample-code interface. It used to be
// computed in the browser from every sample_code the user could read, which is O(n) and undercounts
// when permissions hide rows. This asks Postgres (next_sample_code_number(), the same rule as the
// trigger that assigns the number on save), so it counts every sample. It reveals only that one
// number, and only to signed-in users with app access. The database still decides at save time.
//
// POST /d1-next-number/operation-code  { values: {...}, operation_id?: uuid|null }  ->  { code }
//
// The live preview of an operation's code while the form is being filled in: the code the rule
// (operation_code_for) would give the saved operation, if any, with `values` written over it.
// preview_operation_code reads the saved operation with the database role's rights and checks no
// access, so this route reads the operation and the sample through ItemsService as the requesting
// user first (a user who cannot read either gets 403, and the SQL is not called). Only the columns
// the code is built from are passed on; unknown keys, and free text like notes, are dropped. The
// database still decides the real code at save time.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The code-input columns of manufacturing_operations: the ones in the fast exit of
// trg_manufacturing_operations_set_code (migration 157) plus pass_code itself.
const CODE_KEYS = [
    'pass_code', 'sample_id', 'method_id', 'process_category', 'operation_sequence',
    'machining_operation_subtype', 'machining_cutting_speed_m_per_min',
    'machining_feed_mm_per_rev', 'machining_axial_depth_of_cut_mm',
    'ht_treatment_type', 'ht_peak_temp_celsius', 'ht_hold_time_min', 'ht_cooling_method',
    'deform_deformation_type', 'deform_deformation_temp_celsius',
    'deform_total_reduction_pct', 'deform_pass_count',
    'am_process_variant', 'am_laser_power_w', 'am_scan_speed_mm_per_s', 'am_layer_thickness_mm',
    'sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_mould_diameter_mm',
    'sintering_run_number', 'operation_date', 'equipment_id', 'source_system',
];
// many-to-one columns: the interface may send the related item ({sample_id: {sample_id: '...'}}).
const M2O_KEYS = ['sample_id', 'method_id', 'equipment_id'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A Directus ForbiddenError: it is also what ItemsService throws for an item that does not exist.
const isForbidden = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';

// Returns the whitelisted values, or null when an m2o value is not a uuid (or null).
function cleanValues(values) {
    const out = {};
    for (const key of CODE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
        let v = values[key];
        if (M2O_KEYS.includes(key)) {
            if (isObject(v)) v = v[key];
            if (v === undefined) continue;
            if (v !== null && !(typeof v === 'string' && UUID.test(v))) return null;
        }
        out[key] = v;
    }
    return out;
}

export default {
    id: 'd1-next-number',
    handler: (router, { database, logger, services }) => {
        router.get('/sample', async (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) {
                return res.status(401).json({ error: 'authentication required' });
            }
            if (!(acc.admin || acc.app)) {
                return res.status(403).json({ error: 'forbidden' });
            }
            // ?exclude=a&exclude=b arrives as an array: reject it rather than ignore it.
            const raw = req.query.exclude;
            if (raw !== undefined && typeof raw !== 'string') {
                return res.status(400).json({ error: 'exclude must be a single sample_id (uuid)' });
            }
            const exclude = raw ?? null;
            if (exclude !== null && !UUID.test(exclude)) {
                return res.status(400).json({ error: 'exclude must be a sample_id (uuid)' });
            }
            try {
                const out = await database.raw('SELECT next_sample_code_number(?::uuid) AS next', [exclude]);
                const next = Number(out?.rows?.[0]?.next);
                if (!Number.isFinite(next)) throw new Error('no number returned');
                return res.json({ next });
            } catch (e) {
                logger.error(`d1-next-number: ${e?.message || e}`);
                return res.status(500).json({ error: 'could not read the next sample number' });
            }
        });

        router.post('/operation-code', async (req, res) => {
            const acc = req.accountability;
            if (!acc?.user) {
                return res.status(401).json({ error: 'authentication required' });
            }
            if (!(acc.admin || acc.app)) {
                return res.status(403).json({ error: 'forbidden' });
            }
            const body = req.body;
            if (!isObject(body) || !isObject(body.values)) {
                return res.status(400).json({ error: 'values must be an object' });
            }
            const operationId = body.operation_id ?? null;
            if (operationId !== null && !(typeof operationId === 'string' && UUID.test(operationId))) {
                return res.status(400).json({ error: 'operation_id must be an operation_id (uuid)' });
            }
            const values = cleanValues(body.values);
            if (values === null) {
                return res.status(400).json({ error: 'sample_id, method_id and equipment_id must be uuids' });
            }
            try {
                const itemsFor = (collection) =>
                    new services.ItemsService(collection, { accountability: acc, schema: req.schema });
                // Authorise as the user: the SQL below reads with the database role's rights.
                let savedSample = null;
                if (operationId !== null) {
                    const saved = await itemsFor('manufacturing_operations')
                        .readOne(operationId, { fields: ['operation_id', 'sample_id'] });
                    savedSample = saved?.sample_id ?? null;
                }
                // The code is built with the merged row's sample: the one in values, else the saved one.
                const sampleId = Object.prototype.hasOwnProperty.call(values, 'sample_id')
                    ? values.sample_id
                    : savedSample;
                let sampleCode = null;
                if (sampleId) {
                    const sample = await itemsFor('physical_samples').readOne(sampleId, { fields: ['sample_code'] });
                    sampleCode = sample?.sample_code ?? null;
                }
                const out = await database.raw(
                    'SELECT preview_operation_code(?::jsonb, ?::uuid, ?) AS code',
                    [JSON.stringify(values), operationId, sampleCode],
                );
                return res.json({ code: out?.rows?.[0]?.code ?? null });
            } catch (e) {
                if (isForbidden(e)) {
                    return res.status(403).json({ error: 'forbidden' });
                }
                // 22xxx: a value Postgres cannot read as its column's type (a typed-in "abc" for a number).
                if (typeof e?.code === 'string' && e.code.startsWith('22')) {
                    return res.status(400).json({ error: 'a value is not valid for its field' });
                }
                logger.error(`d1-next-number: ${e?.message || e}`);
                return res.status(500).json({ error: 'could not preview the operation code' });
            }
        });
    },
};
