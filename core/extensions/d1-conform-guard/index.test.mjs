// Run with: node --test core/extensions/d1-conform-guard/index.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import hook, { MESSAGES, OTHER_RUN, ukSpan } from './index.js';

// 2025-07-01 is BST: 12:00Z = 13:00 UK.
const LOG = 'log-1';
const OTHER_LOG = 'log-2';
const iso = (hhmmss, day = '2025-07-01') => `${day}T${hhmmss}.000Z`;

// A knex stand-in that knows the three reads the hook makes:
//   db('conform_logs').where('log_id', id).first(...)
//   db('conform_run_data').where('log_id', id).select(...)  /  .whereIn('id' | 'log_id', keys).select(...) / .first(...)
function fakeDb(tables) {
  const calls = [];
  const db = (table) => {
    const preds = [];
    const rows = () => (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    const builder = {
      where: (col, val) => (preds.push((r) => String(r[col]) === String(val)), builder),
      whereIn: (col, vals) => (preds.push((r) => vals.map(String).includes(String(r[col]))), builder),
      select: async () => (calls.push({ table, read: 'select' }), rows()),
      first: async () => (calls.push({ table, read: 'first' }), rows()[0]),
    };
    return builder;
  };
  db.calls = calls;
  return db;
}

// Directus's ItemsService, as the hook uses it for the caller's own read of an operation: only the ids in `readable` come back; a
// caller with `denyAll` gets a FORBIDDEN error, as Directus answers a collection the policy has no read row for.
function fakeServices({ readable = {}, denyAll = false } = {}) {
  const reads = [];
  class ItemsService {
    constructor(collection, opts) {
      this.collection = collection;
      this.opts = opts;
    }
    async readByQuery(query) {
      reads.push({ collection: this.collection, accountability: this.opts.accountability, query });
      if (denyAll) throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN', status: 403 });
      const id = query.filter.operation_id._eq;
      return id in readable ? [{ operation_id: id, pass_code: readable[id] }] : [];
    }
  }
  return { services: { ItemsService }, reads };
}

const LOG_ROW = { log_id: LOG, log_start: new Date(iso('12:00:00')), log_end: new Date(iso('14:00:00')) };
const OTHER_LOG_ROW = { log_id: OTHER_LOG, log_start: new Date(iso('12:00:00')), log_end: new Date(iso('14:00:00')) };
// run 1 (op-1) holds 12:10:00-12:20:00; run 2 (op-2) holds 12:40:00-12:50:00; run 9 is on another log
const RUNS = [
  { id: 'run-1', operation_id: 'op-1', log_id: LOG, window_start: new Date(iso('12:10:00')), window_end: new Date(iso('12:20:00')) },
  { id: 'run-2', operation_id: 'op-2', log_id: LOG, window_start: new Date(iso('12:40:00')), window_end: new Date(iso('12:50:00')) },
  { id: 'run-9', operation_id: 'op-9', log_id: OTHER_LOG, window_start: new Date(iso('12:00:00')), window_end: new Date(iso('14:00:00')) },
];

function mount(opts = {}) {
  const filters = {};
  const svc = fakeServices(opts);
  hook({ filter: (name, fn) => (filters[name] = fn) }, svc);
  const db = fakeDb({ conform_logs: [LOG_ROW, OTHER_LOG_ROW], conform_run_data: RUNS.map((r) => ({ ...r })) });
  const context = { database: db, schema: { tag: 'schema' }, accountability: { user: 'user-1', admin: false } };
  return { filters, db, context, reads: svc.reads };
}

const refusal = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
};

test('registers filters for conform_run_data create and update and conform_logs delete, nothing else', () => {
  assert.deepEqual(Object.keys(mount().filters).sort(), ['conform_logs.items.delete', 'conform_run_data.items.create', 'conform_run_data.items.update']);
});

test('the refusal has the shape of a Directus InvalidPayloadError: 400, INVALID_PAYLOAD, the sentence as message and extensions.reason', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'PASS-1' } });
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') }, {}, context),
  );
  assert.ok(err instanceof Error);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'INVALID_PAYLOAD');
  assert.equal(err.message, 'Run window overlaps PASS-1 on this log.');
  assert.equal(err.extensions.code, 'INVALID_PAYLOAD');
  assert.equal(err.extensions.reason, err.message);
  assert.equal(err.extensions.source, 'd1-conform-guard');
});

// ---- overlap ---------------------------------------------------------------------------------------------------------------

test('create: overlap with a run the caller can read names its pass_code', async () => {
  const { filters, context, reads } = mount({ readable: { 'op-1': '17-03-25-CF-012-8dia' } });
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') }, {}, context),
  );
  assert.equal(err.message, 'Run window overlaps 17-03-25-CF-012-8dia on this log.');
  // the operation was read with the CALLER's accountability, once, for the first clash only
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].accountability, context.accountability);
  assert.equal(reads[0].collection, 'manufacturing_operations');
  assert.deepEqual(reads[0].query.filter, { operation_id: { _eq: 'op-1' } });
});

test('create: overlap with a run the caller cannot read says "another run" and never the code', async () => {
  const { filters, context } = mount({ readable: {} }); // the read returns no row, as a filtered policy does
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') }, {}, context),
  );
  assert.equal(err.message, `Run window overlaps ${OTHER_RUN} on this log.`);
  assert.equal(err.message, 'Run window overlaps another run on this log.');
});

test('create: a caller with no read right on operations at all also gets "another run"', async () => {
  const { filters, context } = mount({ denyAll: true });
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') }, {}, context),
  );
  assert.equal(err.message, 'Run window overlaps another run on this log.');
});

test('a readable operation without a pass_code is also "another run"', async () => {
  const { filters, context } = mount({ readable: { 'op-1': null } });
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') }, {}, context),
  );
  assert.equal(err.message, 'Run window overlaps another run on this log.');
});

test('with several clashes the earliest window is the one named', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'FIRST', 'op-2': 'SECOND' } });
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:45:00') }, {}, context),
  );
  assert.equal(err.message, 'Run window overlaps FIRST on this log.');
});

test('create: windows that touch [a, b) and [b, c) are accepted, on either side', async () => {
  const { filters, context } = mount();
  for (const [s, e] of [
    ['12:20:00', '12:40:00'], // between run 1 and run 2, touching both
    ['12:00:00', '12:10:00'], // touches run 1 from before, starts at the log's first row
    ['12:50:00', '14:00:00'], // touches run 2 from after, ends at the log's last row
  ]) {
    const payload = { operation_id: 'op-3', log_id: LOG, window_start: iso(s), window_end: iso(e) };
    assert.equal(await filters['conform_run_data.items.create'](payload, {}, context), payload, `${s}-${e}`);
  }
});

test('create: one second into the neighbour is an overlap', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'R1' } });
  const err = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:19:59'), window_end: iso('12:30:00') }, {}, context),
  );
  assert.equal(err.message, 'Run window overlaps R1 on this log.');
});

test('create: a window on another log is not compared with this one, and a run without a window is ignored', async () => {
  const { filters, context } = mount();
  // run 9 holds the whole of log 2, but log 1 is another log: 12:15-12:30 on log 1 clashes with run 1 only
  const onOther = { operation_id: 'op-3', log_id: OTHER_LOG, window_start: iso('12:05:00'), window_end: iso('12:06:00') };
  const err = await refusal(filters['conform_run_data.items.create'](onOther, {}, context));
  assert.equal(err.message, 'Run window overlaps another run on this log.', 'run 9 is what log 2 holds');
  const free = { operation_id: 'op-3', log_id: LOG, window_start: iso('12:25:00'), window_end: iso('12:30:00') };
  assert.equal(await filters['conform_run_data.items.create'](free, {}, context), free, 'run 9 is on log 2');
  // a run that has lost its window (or never had one) cannot overlap anything
  const { filters: f2, context: c2 } = mount();
  c2.database = fakeDb({
    conform_logs: [LOG_ROW],
    conform_run_data: [{ id: 'run-1', operation_id: 'op-1', log_id: LOG, window_start: null, window_end: null }],
  });
  const ok = { operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') };
  assert.equal(await f2['conform_run_data.items.create'](ok, {}, c2), ok);
});

// ---- outside the log -------------------------------------------------------------------------------------------------------

test('create: a window before or after the log says where the log is, in UK time', async () => {
  const { filters, context } = mount();
  for (const [s, e] of [
    ['11:50:00', '12:05:00'],
    ['13:55:00', '14:00:01'],
    ['10:00:00', '16:00:00'],
  ]) {
    const err = await refusal(filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso(s), window_end: iso(e) }, {}, context));
    assert.equal(err.message, 'Run window lies outside the log (13:00:00 to 15:00:00, UK time).', `${s}-${e}`);
    assert.equal(err.extensions.kind, 'outside_log');
  }
});

test('outside the log is judged before overlap (the database checks in that order)', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'R1' } });
  const err = await refusal(filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('14:00:01') }, {}, context));
  assert.match(err.message, /^Run window lies outside the log/);
});

test('ukSpan: clock times only on one UK day, with dates when the log spans two (BST and GMT)', () => {
  assert.deepEqual(ukSpan(Date.parse('2025-07-01T12:00:00Z'), Date.parse('2025-07-01T14:00:00Z')), ['13:00:00', '15:00:00']);
  assert.deepEqual(ukSpan(Date.parse('2025-01-15T09:00:00Z'), Date.parse('2025-01-15T10:30:05Z')), ['09:00:00', '10:30:05']);
  assert.deepEqual(ukSpan(Date.parse('2025-07-01T22:30:00Z'), Date.parse('2025-07-01T23:30:00Z')), ['01/07/2025 23:30:00', '02/07/2025 00:30:00']);
});

test('a window that starts at or after its end is refused with its own sentence', async () => {
  const { filters, context } = mount();
  for (const [s, e] of [
    ['12:30:00', '12:30:00'],
    ['12:31:00', '12:30:00'],
  ]) {
    const err = await refusal(filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso(s), window_end: iso(e) }, {}, context));
    assert.equal(err.message, MESSAGES.windowOrder);
  }
});

// ---- what is not checked ---------------------------------------------------------------------------------------------------

test('create: no log, or only one window end, or an unparseable time, or an unknown log is passed on untouched', async () => {
  const { filters, context, db } = mount();
  const cases = [
    { operation_id: 'op-3' },
    { operation_id: 'op-3', log_id: LOG },
    { operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00') },
    { operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: null },
    { operation_id: 'op-3', window_start: iso('12:15:00'), window_end: iso('12:30:00') },
    { operation_id: 'op-3', log_id: LOG, window_start: 'not a time', window_end: iso('12:30:00') },
    { operation_id: 'op-3', log_id: 'no-such-log', window_start: iso('12:15:00'), window_end: iso('12:30:00') },
  ];
  for (const payload of cases) assert.equal(await filters['conform_run_data.items.create'](payload, {}, context), payload);
  assert.ok(db.calls.every((c) => c.table === 'conform_logs'), 'only the log lookup of the last two cases was needed');
});

test('create: an array payload is checked item by item, and the checks run for administrators and internal calls too', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'R1' } });
  const err = await refusal(
    filters['conform_run_data.items.create'](
      [
        { operation_id: 'op-3', log_id: LOG, window_start: iso('12:20:00'), window_end: iso('12:30:00') },
        { operation_id: 'op-4', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') },
      ],
      {},
      { ...context, accountability: { user: 'admin-1', admin: true } },
    ),
  );
  assert.equal(err.message, 'Run window overlaps R1 on this log.');
  const err2 = await refusal(
    filters['conform_run_data.items.create']({ operation_id: 'op-3', log_id: LOG, window_start: iso('12:15:00'), window_end: iso('12:30:00') }, {}, { ...context, accountability: null }),
  );
  assert.equal(err2.message, 'Run window overlaps R1 on this log.');
});

// ---- update ----------------------------------------------------------------------------------------------------------------

test('update: moving a window one second into the neighbour is refused, the run is not its own neighbour', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'R1' } });
  const err = await refusal(filters['conform_run_data.items.update']({ window_start: iso('12:19:59') }, { keys: ['run-2'] }, context));
  assert.equal(err.message, 'Run window overlaps R1 on this log.');
  // run 2 keeps its own stretch and shrinks, or moves within its own old window: accepted
  const grow = { window_start: iso('12:35:00'), window_end: iso('12:55:00') };
  assert.equal(await filters['conform_run_data.items.update'](grow, { keys: ['run-2'] }, context), grow);
});

test('update: the stored row supplies what the payload leaves out (the log and the other window end)', async () => {
  const { filters, context } = mount({ readable: { 'op-2': 'R2' } });
  const err = await refusal(filters['conform_run_data.items.update']({ window_end: iso('12:45:00') }, { keys: ['run-1'] }, context));
  assert.equal(err.message, 'Run window overlaps R2 on this log.');
  const out = await refusal(filters['conform_run_data.items.update']({ window_end: iso('14:00:01') }, { keys: ['run-2'] }, context));
  assert.match(out.message, /^Run window lies outside the log/);
});

test('update: linking a run (log and both ends) to a log is checked as a create is', async () => {
  const { filters, context } = mount({ readable: { 'op-1': 'R1' } });
  const err = await refusal(
    filters['conform_run_data.items.update']({ log_id: LOG, window_start: iso('12:12:00'), window_end: iso('12:18:00') }, { keys: ['run-9'] }, context),
  );
  assert.equal(err.message, 'Run window overlaps R1 on this log.');
});

test('update: unlinking (log_id and the window set to null) and writes that touch none of the three fields are not checked', async () => {
  const { filters, context, db } = mount();
  const unlink = { log_id: null, window_start: null, window_end: null, summary: null, steps: null, status: 'no_log' };
  assert.equal(await filters['conform_run_data.items.update'](unlink, { keys: ['run-1'] }, context), unlink);
  const status = { status: 'done', summary: { x: 1 } };
  const before = db.calls.length;
  assert.equal(await filters['conform_run_data.items.update'](status, { keys: ['run-1'] }, context), status);
  assert.equal(db.calls.length - before, 0, 'nothing was read');
  assert.deepEqual(await filters['conform_run_data.items.update']({ window_start: iso('12:15:00') }, { keys: [] }, context), { window_start: iso('12:15:00') });
});

// ---- log delete ------------------------------------------------------------------------------------------------------------

test('delete: a log some run still uses is refused in words, for one key and for many', async () => {
  const { filters, context } = mount();
  for (const [payload, meta] of [
    [[LOG], { collection: 'conform_logs' }],
    [['unused-log', LOG], { collection: 'conform_logs' }],
    [undefined, { keys: [LOG] }],
  ]) {
    const err = await refusal(filters['conform_logs.items.delete'](payload, meta, context));
    assert.equal(err.message, 'This log is still used by a Conform run. Unlink it from the run first.');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'INVALID_PAYLOAD');
    assert.equal(err.extensions.kind, 'log_in_use');
  }
});

test('delete: a log no run uses goes through; so does a delete with no key', async () => {
  const { filters, context } = mount();
  const keys = ['unused-log'];
  assert.equal(await filters['conform_logs.items.delete'](keys, { collection: 'conform_logs' }, context), keys);
  assert.deepEqual(await filters['conform_logs.items.delete']([], {}, context), []);
});

test('delete: the refusal does not depend on whether the caller can read the run (run records are private)', async () => {
  const { filters, context } = mount({ denyAll: true });
  const err = await refusal(filters['conform_logs.items.delete']([LOG], {}, context));
  assert.equal(err.message, MESSAGES.logInUse);
});
