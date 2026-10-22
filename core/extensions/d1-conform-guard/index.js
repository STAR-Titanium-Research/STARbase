// Directus hook: d1-conform-guard
//
// Conform runs (docs/superpowers/specs/2026-10-21-conform-runs-design.md, plan "Review round 1"): one uploaded machine log can be
// shared by several Conform runs, each owning a window of it (conform_run_data.window_start / window_end). Migration 208 refuses a
// window that overlaps another run's window or lies outside the log, and migration 210 refuses to delete a log that a run still
// uses, with database triggers. Directus turns the exception of a trigger into a 500 "An unexpected error occurred" for a non-admin,
// so the person who typed the window would never learn what was wrong. This filter hook runs the same checks first and refuses with
// a 400 INVALID_PAYLOAD whose message says it in words. The triggers stay as the backstop (the hook cannot see a concurrent writer;
// the trigger serialises writers on a log with an advisory lock).
//
//   conform_run_data create / update, when the row will have a log and both window ends:
//     * the window must start before it ends        "Run window must start before it ends."
//     * the window must lie inside the log          "Run window lies outside the log (<start> to <end>, UK time)."
//       (the span of the LOG; clock times HH:MM:SS, with the date added when the log spans two UK days)
//     * no overlap with another run's window        "Run window overlaps <code> on this log."
//       <code> is the other run's pass_code when the CALLER can read that operation, otherwise "another run": logs are readable by
//       every lab member but run records are private (ADR-0011), so the refusal must not name a run the caller cannot see.
//       Windows are half-open [start, end): [a, b) and [b, c) touch and are accepted.
//   conform_logs delete: refused while any conform_run_data row still uses the log
//       "This log is still used by a Conform run. Unlink it from the run first."
//
// The checks apply to every caller, administrators and internal calls included: the readable message is for whoever hits the trigger.
// Only what the caller may read changes the wording (the operation lookup below runs with the caller's accountability).
//
// Errors have the shape of a Directus InvalidPayloadError (status 400, code INVALID_PAYLOAD, extensions.reason) without importing
// @directus/errors, as d1-access-guard does for its 403s. `message` and `extensions.reason` are the plain sentence.

const SOURCE = 'd1-conform-guard';

export const MESSAGES = {
  windowOrder: 'Run window must start before it ends.',
  outside: (start, end) => `Run window lies outside the log (${start} to ${end}, UK time).`,
  overlap: (code) => `Run window overlaps ${code} on this log.`,
  logInUse: 'This log is still used by a Conform run. Unlink it from the run first.',
};
export const OTHER_RUN = 'another run';

function invalidPayload(reason, details = {}) {
  const err = new Error(reason);
  err.name = 'DirectusError';
  err.status = 400;
  err.code = 'INVALID_PAYLOAD';
  err.extensions = { code: 'INVALID_PAYLOAD', reason, source: SOURCE, ...details };
  return err;
}

const isBlank = (value) => value === undefined || value === null || value === '';
const isDenied = (err) => err?.code === 'FORBIDDEN' || err?.status === 403;

// A timestamp as it reaches a hook: an ISO string in a payload, a Date from the database, or epoch milliseconds. NaN when it is none.
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Date.parse(value);
  return NaN;
}

const UK_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric' });
const UK_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// "HH:MM:SS" in UK local time; with the date ("DD/MM/YYYY HH:MM:SS") when the two instants fall on different UK days.
export function ukSpan(startMs, endMs) {
  const sameDay = UK_DAY.format(startMs) === UK_DAY.format(endMs);
  const one = (ms) => (sameDay ? UK_CLOCK.format(ms) : `${UK_DAY.format(ms)} ${UK_CLOCK.format(ms)}`);
  return [one(startMs), one(endMs)];
}

export default ({ filter }, { services }) => {
  const { ItemsService } = services;

  // The pass_code of an operation when the caller may read it, else null (not readable, missing, or no code).
  async function readableCode(operationId, context) {
    try {
      const svc = new ItemsService('manufacturing_operations', {
        knex: context.database,
        schema: context.schema,
        accountability: context.accountability,
      });
      const rows = await svc.readByQuery({
        fields: ['operation_id', 'pass_code'],
        filter: { operation_id: { _eq: operationId } },
        limit: 1,
      });
      const code = rows?.[0]?.pass_code;
      return isBlank(code) ? null : String(code);
    } catch (err) {
      if (isDenied(err)) return null;
      throw err;
    }
  }

  // Refuses (throws) a run row, as it will be after the write, whose window the database would refuse. `selfId` is the row's own id
  // (null on create); `row` has log_id, window_start and window_end (any may be blank: then there is nothing to check).
  async function checkWindow(row, selfId, context) {
    if (isBlank(row.log_id) || isBlank(row.window_start) || isBlank(row.window_end)) return;
    const start = toMs(row.window_start);
    const end = toMs(row.window_end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return; // Directus's own validation words that
    if (start >= end) throw invalidPayload(MESSAGES.windowOrder, { kind: 'window_order' });

    const db = context.database;
    const log = await db('conform_logs').where('log_id', row.log_id).first('log_start', 'log_end');
    if (!log) return; // the foreign key and d1-access-guard say what is wrong with an unknown log
    const logStart = toMs(log.log_start);
    const logEnd = toMs(log.log_end);
    if (start < logStart || end > logEnd) {
      const [from, to] = ukSpan(logStart, logEnd);
      throw invalidPayload(MESSAGES.outside(from, to), { kind: 'outside_log', collection: 'conform_run_data' });
    }

    const others = await db('conform_run_data').where('log_id', row.log_id).select('id', 'operation_id', 'window_start', 'window_end');
    const clashes = others
      .filter((o) => String(o.id) !== String(selfId) && !isBlank(o.window_start) && !isBlank(o.window_end))
      .map((o) => ({ ...o, startMs: toMs(o.window_start), endMs: toMs(o.window_end) }))
      .filter((o) => o.startMs < end && start < o.endMs) // half-open: touching windows do not overlap
      .sort((a, b) => a.startMs - b.startMs);
    if (clashes.length === 0) return;
    const code = (await readableCode(clashes[0].operation_id, context)) ?? OTHER_RUN;
    throw invalidPayload(MESSAGES.overlap(code), { kind: 'overlap', collection: 'conform_run_data' });
  }

  filter('conform_run_data.items.create', async (payload, meta, context) => {
    if (!payload || !context?.database) return payload;
    for (const item of Array.isArray(payload) ? payload : [payload]) {
      if (item && typeof item === 'object') await checkWindow(item, null, context);
    }
    return payload;
  });

  filter('conform_run_data.items.update', async (payload, meta, context) => {
    if (!payload || typeof payload !== 'object' || !context?.database) return payload;
    // only a change to the log or to a window end can break the rule
    if (!['log_id', 'window_start', 'window_end'].some((field) => field in payload)) return payload;
    const keys = (Array.isArray(meta?.keys) ? meta.keys : []).filter((key) => !isBlank(key));
    if (keys.length === 0) return payload;
    const stored = await context.database('conform_run_data').whereIn('id', keys).select('id', 'log_id', 'window_start', 'window_end');
    for (const row of stored) await checkWindow({ ...row, ...payload }, row.id, context);
    return payload;
  });

  filter('conform_logs.items.delete', async (payload, meta, context) => {
    const keys = (Array.isArray(payload) ? payload : (meta?.keys ?? [])).filter((key) => !isBlank(key) && typeof key !== 'object');
    if (keys.length === 0 || !context?.database) return payload;
    const used = await context.database('conform_run_data').whereIn('log_id', keys).first('id');
    if (used) throw invalidPayload(MESSAGES.logInUse, { kind: 'log_in_use', collection: 'conform_logs' });
    return payload;
  });
};
