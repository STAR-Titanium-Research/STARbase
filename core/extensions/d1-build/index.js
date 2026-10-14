// Directus endpoint: d1-build  (mounted at /d1-build)
//
// The server half of the process map's edit mode (ADR-0018, ADR-0019; spec
// docs/superpowers/specs/2026-10-14-process-map-edit-mode-design.md sections 5 and 6, migrations 185 and 186).
// The browser builds a DRAFT (a DraftBody, spec 5.1: items, wires, positions) and this endpoint keeps it, checks it,
// and turns the whole draft into real records in ONE database transaction.
//
//   GET    /d1-build/drafts                 -> { data: [{ id, name, updated_at, summary }] }   the caller's drafts, newest first;
//                                              summary is one line of what Create would make ("2 operations, 4 samples")
//   POST   /d1-build/drafts {name?, body}   -> 201 { data: { id, name, body, version, updated_at } }
//   GET    /d1-build/drafts/:id             -> { data: { id, name, body, version, updated_at } }     owner only, else 404
//   PATCH  /d1-build/drafts/:id {name?, body?, version}  -> { data: { id, name, body, version, updated_at } }
//                                              409 CONFLICT when version is not the stored one (another tab saved first)
//   DELETE /d1-build/drafts/:id             -> 204
//   POST   /d1-build/drafts/:id/check       -> { data: { checks: Check[] } }                  (the server's checks, spec E5, E13)
//   POST   /d1-build/drafts/:id/create      -> { data: { created: { [DraftKey]: { collection, id, code } }, sampleIds: string[] } }
//                                              409 { errors: [{ extensions: { code: 'CHECKS', checks } }] } when a blocking check holds
//                                              (nothing is written); a failed write: { errors: [{ extensions: { code: 'WRITE_FAILED', key } }] }
//                                              (everything is rolled back, the draft is untouched)
//   POST   /d1-build/mark-done {collection, id, date?, personId?} -> { data: { id, work_state: 'done' } }  (409 CHECKS as above)
//   GET    /d1-build/templates              -> { data: [{ id, name, scope, role_id, collection, values, user_id, updated_at, version }] }
//   GET    /d1-build/templates/:id, POST /d1-build/templates, PATCH /d1-build/templates/:id, DELETE /d1-build/templates/:id
//   Check = { key: DraftKey (or a record id for mark-done); field?: string; level: 'block' | 'warn'; text: string }
//
// Every route needs a signed-in user (401 otherwise). Errors have the Directus shape
// { errors: [{ message, extensions: { code, source: 'd1-build', ... } }] }.
//
// How it runs (the d1-record-access and d1-people-admin pattern):
//   * Drafts and templates live in d1_private (migration 186): outside the Directus schema scan, reached only here, with
//     plain parameterised SQL. A draft is private to its owner (every query names user_id); a save names the version it was
//     made against (UPDATE ... WHERE version = ?), so a stale tab gets 409 instead of overwriting.
//   * The caller's reads and writes of RECORDS go through Directus's ItemsService with the caller's accountability and, for
//     writes, `knex: trx` (the one transaction), so Directus permissions and every hook (d1-owner-default, d1-access-guard,
//     d1-campaign-inherit, the code triggers' inputs ...) apply exactly as for a form save. Every write transaction starts with
//     set_config('d1.actor_identity', <caller>, true), so the audit trigger names the caller. The Directus data cache is cleared
//     after a commit when CACHE_ENABLED is on (knex writes bypass the services that do it).
//   * Testable without Directus: mount(router, { database, services, getSchema, logger, env }, clock) takes everything it uses,
//     and the pure parts are exported (validateDraftBody, summarise, orderOperations, buildPlan, computeChecks ...).
//
// Naming of keys: a DraftKey names an item (a sample, an operation, a test). An operation's `rows` (one per output piece) have
// their own keys; `created` holds one entry per created record: a sample or test under its item key, an operation under each of
// its row keys (and under its item key too, for its first row, unless a row key is the same).

const SOURCE = 'd1-build';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const FIELD = /^[a-z_][a-z0-9_]{0,63}$/;

// Limits that keep one draft a draft and not a dump: the body is a few hundred small objects at most.
export const LIMITS = { bodyChars: 1_000_000, items: 300, rows: 100, wires: 1000, name: 200, positions: 1000 };

export const WORK_STATES = ['planned', 'done'];
export const KINDS = ['sample', 'operation', 'test'];

// What each kind of item makes.
export const KIND_COLLECTION = { sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions' };
export const COLLECTION_PK = {
  physical_samples: 'sample_id',
  manufacturing_operations: 'operation_id',
  test_sessions: 'session_id',
  batches: 'batch_id',
  campaign_samples: 'id',
};
// The column that holds a record's human code.
export const COLLECTION_CODE = {
  physical_samples: 'sample_code',
  manufacturing_operations: 'pass_code',
  test_sessions: 'test_code',
};

// What the checks read of a draft's existing records (as the caller): the version, the state, and the fields a new record may
// inherit.
const READ_FIELDS = {
  physical_samples: ['sample_id', 'version', 'sample_code', 'current_status', 'material_id', 'form', 'primary_method_id', 'project_id'],
  manufacturing_operations: ['operation_id', 'version', 'pass_code', 'sample_id', 'output_sample_id', 'method_id', 'work_state', 'batch_id'],
  test_sessions: ['session_id', 'version', 'test_code', 'work_state', 'test_type'],
};

// Fields the wiring or the server decides, so a draft's `values` may not carry them (the endpoint writes them from the wires,
// the work state and the database). Refusing them on save keeps a client bug from silently rewiring or marking something done.
const COMMON_RESERVED = ['version', 'created_at', 'updated_at', 'short_id', 'code_sort', 'created_by', 'restricted'];
export const RESERVED_FIELDS = {
  sample: ['sample_id', 'current_status', ...COMMON_RESERVED],
  operation: [
    'operation_id', 'sample_id', 'output_sample_id', 'work_state', 'done_by_person_id', 'done_at', 'batch_id',
    ...COMMON_RESERVED,
  ],
  test: [
    'session_id', 'sample_id', 'subject', 'work_state', 'done_by_person_id', 'done_at', 'batch_id', 'insert_edge_id',
    ...COMMON_RESERVED,
  ],
};

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const isBlank = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const trimmed = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const rowsOf = (out) => out?.rows ?? [];
const toIso = (t) => (t instanceof Date ? t.toISOString() : t == null ? null : new Date(t).toISOString());

// ---- the draft body: validation (spec 5.1) ---------------------------------------------------------------------------

const fail = (message) => ({ ok: false, message });
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;

// Checks the SHAPE of a DraftBody and returns { ok: true, body } or { ok: false, message }. What a draft means (a wire to
// nothing, an operation without a method) is the checks' job, not the save's: a draft is saved while it is still being built.
// Unknown extra properties are kept as they come (a client may carry its own), the known ones must be well-formed.
export function validateDraftBody(input) {
  if (!isObject(input)) return fail('The draft body must be an object.');
  if (input.v !== 1) return fail('The draft body must have v: 1.');
  for (const f of ['projectId', 'campaignId']) {
    const v = input[f];
    if (v !== null && v !== undefined && !(typeof v === 'string' && UUID.test(v))) return fail(`${f} must be an id or null.`);
  }
  if (!Array.isArray(input.items)) return fail('items must be a list.');
  if (!Array.isArray(input.wires)) return fail('wires must be a list.');
  if (!isObject(input.positions)) return fail('positions must be an object.');
  if (input.items.length > LIMITS.items) return fail(`A draft holds at most ${LIMITS.items} items.`);
  if (input.wires.length > LIMITS.wires) return fail(`A draft holds at most ${LIMITS.wires} wires.`);
  if (Object.keys(input.positions).length > LIMITS.positions) return fail('positions holds too many entries.');

  for (const [i, item] of input.items.entries()) {
    const at = `items[${i}]`;
    if (!isObject(item)) return fail(`${at} must be an object.`);
    if (typeof item.key !== 'string' || !KEY.test(item.key)) return fail(`${at}.key must be a short key (letters, digits, - and _).`);
    if (!KINDS.includes(item.kind)) return fail(`${at}.kind must be sample, operation or test.`);
    if (!isObject(item.values)) return fail(`${at}.values must be an object.`);
    for (const field of Object.keys(item.values)) {
      if (!FIELD.test(field)) return fail(`${at}.values has a field name that is not allowed: ${field.slice(0, 40)}.`);
      if (RESERVED_FIELDS[item.kind].includes(field)) {
        return fail(`${at}.values must not set ${field}: the wiring and the server decide it.`);
      }
    }
    if (item.existing !== undefined) {
      const e = item.existing;
      if (!isObject(e) || typeof e.id !== 'string' || !UUID.test(e.id) || !isInt(e.version, 0)) {
        return fail(`${at}.existing must be { id, version }.`);
      }
    }
    if (item.remove !== undefined && item.remove !== true) return fail(`${at}.remove must be true when present.`);
    if (item.kind !== 'sample' && !WORK_STATES.includes(item.workState)) return fail(`${at}.workState must be planned or done.`);
    if (item.attach !== undefined && (item.attach !== true || item.kind !== 'operation')) {
      return fail(`${at}.attach is true on an operation only.`);
    }
    if (item.kind === 'operation') {
      if (!Array.isArray(item.rows)) return fail(`${at}.rows must be a list.`);
      if (item.rows.length > LIMITS.rows) return fail(`${at} has too many rows.`);
      for (const [r, row] of item.rows.entries()) {
        if (!isObject(row) || typeof row.key !== 'string' || !KEY.test(row.key)) return fail(`${at}.rows[${r}].key must be a short key.`);
      }
    }
  }
  for (const [i, wire] of input.wires.entries()) {
    const at = `wires[${i}]`;
    if (!isObject(wire)) return fail(`${at} must be an object.`);
    for (const end of ['from', 'to']) {
      const e = wire[end];
      if (!isObject(e) || typeof e.key !== 'string' || !KEY.test(e.key)) return fail(`${at}.${end}.key must be a short key.`);
      if (e.row !== undefined && !isInt(e.row, 0)) return fail(`${at}.${end}.row must be a row number.`);
    }
  }
  for (const [key, p] of Object.entries(input.positions)) {
    if (!KEY.test(key)) return fail('positions has a key that is not a short key.');
    if (!isObject(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return fail(`positions.${key} must be { x, y } numbers.`);
  }
  if (JSON.stringify(input).length > LIMITS.bodyChars) return fail('The draft is too large.');
  return { ok: true, body: input };
}

// A name: 1 to 200 characters once trimmed.
export function validateName(name) {
  const t = trimmed(name);
  if (!t) return fail('A name is needed.');
  if (t.length > LIMITS.name) return fail(`A name is at most ${LIMITS.name} characters.`);
  return { ok: true, name: t };
}

// ---- the summary line (spec 5.2 summary.ts, server side) -------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What Create would make or change, in words: "2 operations, 4 samples". New records only count as records (an operation with
// four rows is four operations); existing records count when they carry edits or a removal. An empty draft says so.
export function summarise(body) {
  const items = Array.isArray(body?.items) ? body.items : [];
  let operations = 0;
  let samples = 0;
  let tests = 0;
  let edits = 0;
  let removals = 0;
  for (const item of items) {
    if (item?.remove) {
      removals += 1;
    } else if (item?.existing) {
      if (item.attach || (isObject(item.values) && Object.keys(item.values).length > 0)) edits += 1;
    } else if (item?.kind === 'operation') {
      operations += Array.isArray(item.rows) && item.rows.length > 0 ? item.rows.length : 1;
    } else if (item?.kind === 'sample') {
      samples += 1;
    } else if (item?.kind === 'test') {
      tests += 1;
    }
  }
  const parts = [];
  if (operations) parts.push(plural(operations, 'operation', 'operations'));
  if (samples) parts.push(plural(samples, 'sample', 'samples'));
  if (tests) parts.push(plural(tests, 'test', 'tests'));
  if (edits) parts.push(plural(edits, 'change to an existing record', 'changes to existing records'));
  if (removals) parts.push(plural(removals, 'removal', 'removals'));
  return parts.length ? parts.join(', ') : 'Empty';
}

// ---- SQL (parameterised; exported so the schema tests can run these exact statements) ---------------------------------

export const SQL = {
  setActor: "SELECT set_config('d1.actor_identity', ?, true)",
  listDrafts:
    'SELECT draft_id, name, body, updated_at FROM d1_private.process_drafts'
    + ' WHERE user_id = ? ORDER BY updated_at DESC, draft_id LIMIT 200',
  getDraft:
    'SELECT draft_id, name, body, version, updated_at FROM d1_private.process_drafts WHERE draft_id = ? AND user_id = ?',
  lockDraft:
    'SELECT draft_id, name, body, version, updated_at FROM d1_private.process_drafts'
    + ' WHERE draft_id = ? AND user_id = ? FOR UPDATE',
  insertDraft:
    'INSERT INTO d1_private.process_drafts (user_id, name, body) VALUES (?, ?, ?::jsonb)'
    + ' RETURNING draft_id, name, body, version, updated_at',
  // Bindings: name (or null), body JSON (or null), id, user, the version the save was made against.
  updateDraft:
    'UPDATE d1_private.process_drafts SET name = COALESCE(?, name), body = COALESCE(?::jsonb, body),'
    + ' version = version + 1, updated_at = now()'
    + ' WHERE draft_id = ? AND user_id = ? AND version = ?'
    + ' RETURNING draft_id, name, body, version, updated_at',
  deleteDraft: 'DELETE FROM d1_private.process_drafts WHERE draft_id = ? AND user_id = ?',
  // The fields the forms mark required (Directus does not enforce the flag on API saves, so the checks do).
  requiredFields:
    'SELECT collection, field, translations FROM directus_fields WHERE required = true'
    + " AND collection IN ('physical_samples', 'manufacturing_operations', 'test_sessions') ORDER BY collection, sort, field",
  // Each takes the ids as one comma-separated text (all uuids, validated before they get here).
  sampleInfo:
    "SELECT sample_id, sample_code, current_status FROM physical_samples WHERE sample_id = ANY(string_to_array(?, ',')::uuid[])",
  refsOperations:
    'SELECT operation_id, work_state, sample_id, output_sample_id FROM manufacturing_operations'
    + " WHERE sample_id = ANY(string_to_array(?, ',')::uuid[]) OR output_sample_id = ANY(string_to_array(?, ',')::uuid[])",
  refsTests:
    "SELECT session_id, work_state, sample_id FROM test_sessions WHERE sample_id = ANY(string_to_array(?, ',')::uuid[])",
  refsSubjects:
    'SELECT s.test_sessions_id AS session_id, t.work_state, s.item AS sample_id FROM test_sessions_subject s'
    + ' JOIN test_sessions t ON t.session_id = s.test_sessions_id'
    + " WHERE s.collection = 'physical_samples' AND s.item = ANY(string_to_array(?, ',')::text[])",
};

// ---- planning: what a draft means (pure) -----------------------------------------------------------------------------
//
// buildPlan(body, ctx) reads a DraftBody against what the database knows and answers { checks, plan }:
//   * checks: the Check list (spec E5, E13), blocking or warning;
//   * plan: what Create would write, in order (spec 6.1), with every wire already resolved to a "ref":
//       'item:<key>'  a sample card of the draft (new, or created in this Create; resolved to its id when written)
//       'id:<uuid>'   a sample that exists already
//     Nothing in the plan is written unless no check blocks.
// ctx (all optional, as loaded by the endpoint):
//   existing  Map(lower-case id -> row)  the draft's existing records as the CALLER can read them (a record missing here is
//             gone or unreadable); samples also carry material_id, form ... for inheritance
//   required  { [collection]: [{ field, label }] }  the fields the forms mark required (parseRequired)
//   outputs   Map(sample id -> { code, status })    the output samples of removed operations, and removed samples
//   refs      [{ kind: 'operation'|'test', id, work_state, sampleIds }]  every record that points at a sample that would go

const lower = (s) => String(s).toLowerCase();
const idRef = (id) => (isBlank(id) ? null : `id:${lower(id)}`);
const itemRef = (key) => `item:${key}`;
const keyOrder = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const hasValues = (item) => isObject(item.values) && Object.keys(item.values).length > 0;

// The fields the forms mark required, by collection, with their label: [{ collection, field, translations }] rows from
// directus_fields.
export function parseRequired(rows) {
  const out = {};
  for (const r of rows ?? []) {
    let t = r.translations;
    if (typeof t === 'string') {
      try { t = JSON.parse(t); } catch { t = null; }
    }
    const en = Array.isArray(t) ? (t.find((x) => x?.language === 'en-US') ?? t[0]) : null;
    (out[r.collection] ??= []).push({ field: r.field, label: trimmed(en?.translation) ?? r.field });
  }
  return out;
}

// Put operation records in the order they must be written (spec 6.1 step 6). A record waits for the records that make the
// sample it works on (its input is another record's output) and for the records it is wired from; everything else keeps the
// order of the draft (`index`), so the passes of an in-place chain are numbered as they were laid out. records:
// [{ key, index, input, output, after? }]. Returns { order: records, cyclic: keys } (a loop is appended in draft order).
export function orderOperations(records) {
  const sorted = [...records].sort((a, b) => a.index - b.index);
  const byKey = new Map(sorted.map((r) => [r.key, r]));
  const makers = new Map();
  for (const r of sorted) if (r.output) makers.set(r.output, [...(makers.get(r.output) ?? []), r.key]);
  const needs = new Map(sorted.map((r) => [r.key, new Set()]));
  for (const r of sorted) {
    for (const maker of r.input ? (makers.get(r.input) ?? []) : []) if (maker !== r.key) needs.get(r.key).add(maker);
    for (const before of r.after ?? []) if (byKey.has(before) && before !== r.key) needs.get(r.key).add(before);
  }
  const placed = new Set();
  const order = [];
  for (;;) {
    const next = sorted.find((r) => !placed.has(r.key) && [...needs.get(r.key)].every((k) => placed.has(k)));
    if (!next) break;
    placed.add(next.key);
    order.push(next);
  }
  const cyclic = sorted.filter((r) => !placed.has(r.key));
  return { order: [...order, ...cyclic], cyclic: cyclic.map((r) => r.key) };
}

export function buildPlan(body, ctx = {}) {
  const existing = ctx.existing ?? new Map();
  const required = ctx.required ?? {};
  const outputsInfo = ctx.outputs ?? new Map();
  const refs = ctx.refs ?? [];
  const items = Array.isArray(body?.items) ? body.items : [];
  const wires = Array.isArray(body?.wires) ? body.wires : [];

  const checks = [];
  const seen = new Set();
  const blockedFields = new Set();
  const note = (level) => (key, text, field) => {
    const id = `${level}|${key}|${field ?? ''}|${text}`;
    if (seen.has(id)) return;
    seen.add(id);
    if (level === 'block' && field) blockedFields.add(`${key}|${field}`);
    checks.push({ key, ...(field ? { field } : {}), level, text });
  };
  const block = note('block');
  const warn = note('warn');

  // -- the cards ------------------------------------------------------------------------------------------------
  const byKey = new Map();
  for (const item of items) {
    if (byKey.has(item.key)) block(item.key, 'Two cards in this draft share a key. Reload the draft.');
    else byKey.set(item.key, item);
  }
  const rowsFor = (item) => (Array.isArray(item.rows) && item.rows.length ? item.rows : [{ key: item.key }]);
  const owners = new Map([...byKey.keys()].map((k) => [k, k]));
  for (const item of items) {
    if (item.kind !== 'operation') continue;
    for (const row of rowsFor(item)) {
      if (row.key === item.key) continue;
      if (owners.has(row.key)) block(item.key, 'Two rows or cards in this draft share a key. Reload the draft.');
      else owners.set(row.key, item.key);
    }
  }
  const stored = (item) => (item.existing ? existing.get(lower(item.existing.id)) : undefined);
  const isNew = (item) => !item.existing;
  const live = (item) => !item.remove;

  // The rows that Create writes or works through: new operations, attached operations (an existing operation given an input)
  // and, for wiring only, the stored wiring of existing operations. rowId = `${itemKey}#${index}`.
  const opRows = new Map();
  for (const item of items) {
    if (item.kind !== 'operation' || !live(item) || byKey.get(item.key) !== item) continue;
    const mode = isNew(item) ? 'new' : item.attach ? 'attach' : 'existing';
    rowsFor(item).forEach((row, i) => {
      opRows.set(`${item.key}#${i}`, { item, index: i, rowKey: row.key, mode, row: stored(item), count: rowsFor(item).length });
    });
  }

  // -- the wires ------------------------------------------------------------------------------------------------
  const inWires = new Map(); // rowId -> [{ kind: 'sample'|'op', key, row? }]
  const outWires = new Map(); // rowId -> [sample key]
  const subjects = new Map(); // test key -> [{ kind: 'sample'|'op', key, row? }]
  const push = (map, k, v) => map.set(k, [...(map.get(k) ?? []), v]);
  const rowSel = (end, label) => {
    const count = rowsFor(end.item).length;
    if (end.row === undefined) {
      if (count > 1) block(end.item.key, `Say which row ${label}: this operation has ${count}.`);
      return 0;
    }
    if (end.row >= count) {
      block(end.item.key, 'A wire names a row this operation does not have.');
      return null;
    }
    return end.row;
  };
  for (const w of wires) {
    const from = byKey.has(w.from.key) ? { item: byKey.get(w.from.key), row: w.from.row } : null;
    const to = byKey.has(w.to.key) ? { item: byKey.get(w.to.key), row: w.to.row } : null;
    if (!from || !to) {
      block((from ?? to)?.item.key ?? w.from.key, 'A wire points at a card that is no longer in the draft.');
      continue;
    }
    if (from.item.remove || to.item.remove) {
      block(from.item.remove ? to.item.key : from.item.key, 'This card is wired to something that is being removed.');
      continue;
    }
    const fk = from.item.kind;
    const tk = to.item.kind;
    if (tk === 'operation' && (fk === 'sample' || fk === 'operation')) {
      if (!isNew(to.item) && !to.item.attach) continue; // an existing operation keeps the wiring it has
      const src = fk === 'sample' ? { kind: 'sample', key: from.item.key } : { kind: 'op', key: from.item.key, row: rowSel(from, 'it comes from') };
      if (src.row === null) continue;
      const rows = to.row === undefined ? rowsFor(to.item).map((_, i) => i) : [rowSel(to, 'it goes into')];
      for (const i of rows) if (i !== null) push(inWires, `${to.item.key}#${i}`, src);
    } else if (fk === 'operation' && tk === 'sample') {
      if (!isNew(from.item) && !from.item.attach) continue;
      const i = rowSel(from, 'the sample comes from');
      if (i !== null) push(outWires, `${from.item.key}#${i}`, to.item.key);
    } else if (tk === 'test' && (fk === 'sample' || fk === 'operation')) {
      if (!isNew(to.item)) continue;
      const src = fk === 'sample' ? { kind: 'sample', key: from.item.key } : { kind: 'op', key: from.item.key, row: rowSel(from, 'it comes from') };
      if (src.row !== null) push(subjects, to.item.key, src);
    } else {
      block(from.item.key, 'These two cards cannot be wired together.');
    }
  }

  // -- who works on which sample ----------------------------------------------------------------------------------
  const distinct = (list) => {
    const out = [];
    for (const s of list ?? []) if (!out.some((o) => o.kind === s.kind && o.key === s.key && o.row === s.row)) out.push(s);
    return out;
  };
  const refOfSampleItem = (item) => (item.existing ? idRef(item.existing.id) : itemRef(item.key));
  const memo = new Map();
  const BUSY = Symbol('busy');
  let looped = false;
  const memoised = (id, fn, key) => {
    if (memo.has(id)) {
      const v = memo.get(id);
      if (v === BUSY) {
        if (!looped) block(key, 'These operations are wired in a loop.');
        looped = true;
        return null;
      }
      return v;
    }
    memo.set(id, BUSY);
    const v = fn();
    memo.set(id, v);
    return v;
  };
  const inputOf = (rowId) => {
    const info = opRows.get(rowId);
    if (!info) return null;
    return memoised(`in:${rowId}`, () => {
      if (info.mode === 'existing') return idRef(info.row?.sample_id);
      const srcs = distinct(inWires.get(rowId));
      if (srcs.length > 1) block(info.item.key, 'More than one wire goes into this operation.');
      const s = srcs[0];
      if (!s) return null;
      return s.kind === 'sample' ? refOfSampleItem(byKey.get(s.key)) : continuesAs(`${s.key}#${s.row}`);
    }, info.item.key);
  };
  const outputOf = (rowId) => {
    const info = opRows.get(rowId);
    if (!info) return null;
    return memoised(`out:${rowId}`, () => {
      if (info.mode !== 'new') return idRef(info.row?.output_sample_id);
      const outs = [...new Set(outWires.get(rowId) ?? [])];
      if (outs.length > 1) block(info.item.key, 'More than one sample is wired out of this row.');
      if (!outs.length) return null;
      const target = refOfSampleItem(byKey.get(outs[0]));
      return target === inputOf(rowId) ? null : target; // the same sample out: in place
    }, info.item.key);
  };
  function continuesAs(rowId) {
    return outputOf(rowId) ?? inputOf(rowId);
  }

  // -- operations (new and attached) -------------------------------------------------------------------------------
  const records = [];
  let order = 0;
  for (const item of items) {
    if (item.kind !== 'operation' || !live(item) || byKey.get(item.key) !== item || (!isNew(item) && !item.attach)) continue;
    const mode = isNew(item) ? 'new' : 'attach';
    let anyEnd = false;
    rowsFor(item).forEach((row, i) => {
      const rowId = `${item.key}#${i}`;
      const input = inputOf(rowId);
      const output = outputOf(rowId);
      if (input || output) anyEnd = true;
      const after = distinct(inWires.get(rowId)).filter((s) => s.kind === 'op').map((s) => opRows.get(`${s.key}#${s.row}`)?.rowKey).filter(Boolean);
      records.push({
        key: row.key, itemKey: item.key, rowIndex: i, mode, input, output, workState: item.workState, values: item.values,
        existingId: item.existing ? lower(item.existing.id) : null, version: item.existing?.version ?? null,
        batchKey: mode === 'new' && rowsFor(item).length > 1 ? item.key : null, after, index: order,
      });
      order += 1;
    });
    if (mode === 'new' && isBlank(item.values.method_id)) block(item.key, 'Choose a method.', 'method_id');
    if (mode === 'new' && !anyEnd) block(item.key, 'Wire a sample into this operation, or give it an output.');
    if (mode === 'attach' && !records.some((r) => r.itemKey === item.key && r.input)) {
      block(item.key, 'Wire a sample into this operation to attach it.');
    }
  }
  const ordered = orderOperations(records);
  for (const key of ordered.cyclic) block(records.find((r) => r.key === key).itemKey, 'These operations are wired in a loop.');

  // Who makes each sample: one operation row at most.
  const makers = new Map();
  for (const r of records) if (r.output) makers.set(r.output, [...(makers.get(r.output) ?? []), r]);
  for (const [ref, rs] of makers) {
    if (rs.length > 1 && ref.startsWith('item:')) block(ref.slice(5), 'More than one operation makes this sample.');
  }

  // -- samples (new) ------------------------------------------------------------------------------------------------------
  const sampleValues = (ref, trail = new Set()) => {
    if (!ref) return {};
    if (ref.startsWith('id:')) return existing.get(ref.slice(3)) ?? {};
    const item = byKey.get(ref.slice(5));
    if (!item) return {};
    if (item.existing) return { ...(stored(item) ?? {}), ...item.values };
    return effectiveSample(item, trail);
  };
  const effectCache = new Map();
  const effectiveSample = (item, trail = new Set()) => {
    if (effectCache.has(item.key)) return effectCache.get(item.key);
    if (trail.has(item.key)) return { ...item.values };
    trail.add(item.key);
    const made = makers.get(itemRef(item.key))?.[0];
    const inherited = {};
    if (made) {
      const from = sampleValues(made.input, trail);
      inherited.material_id = from.material_id;
      inherited.form = from.form;
      const opItem = byKey.get(made.itemKey);
      inherited.primary_method_id = made.mode === 'new' ? opItem.values.method_id : opRows.get(`${made.itemKey}#0`)?.row?.method_id;
    }
    inherited.project_id = body?.projectId ?? undefined;
    const out = { ...Object.fromEntries(Object.entries(inherited).filter(([, v]) => !isBlank(v))) };
    for (const [k, v] of Object.entries(item.values)) if (!isBlank(v)) out[k] = v;
    trail.delete(item.key);
    effectCache.set(item.key, out);
    return out;
  };

  const samples = [];
  for (const item of [...items].sort((a, b) => keyOrder(a.key, b.key))) {
    if (item.kind !== 'sample' || !isNew(item) || !live(item) || byKey.get(item.key) !== item) continue;
    const made = makers.get(itemRef(item.key))?.[0];
    const planned = made?.workState === 'planned';
    const values = effectiveSample(item);
    if (isBlank(values.sample_code)) block(item.key, 'Give the sample a code.', 'sample_code');
    if (!planned) {
      for (const { field, label } of required.physical_samples ?? []) {
        if (RESERVED_FIELDS.sample.includes(field) || blockedFields.has(`${item.key}|${field}`)) continue;
        if (isBlank(values[field])) block(item.key, `${label} is required.`, field);
      }
    }
    samples.push({ key: item.key, values, planned });
  }

  // -- tests (new) --------------------------------------------------------------------------------------------------------
  const tests = [];
  for (const item of items) {
    if (item.kind !== 'test' || !isNew(item) || !live(item) || byKey.get(item.key) !== item) continue;
    const subjectRefs = [];
    for (const s of distinct(subjects.get(item.key))) {
      const ref = s.kind === 'sample' ? refOfSampleItem(byKey.get(s.key)) : continuesAs(`${s.key}#${s.row}`);
      if (ref && !subjectRefs.includes(ref)) subjectRefs.push(ref);
    }
    if (isBlank(item.values.test_type)) block(item.key, 'Choose a test type.', 'test_type');
    if (!subjectRefs.length) block(item.key, 'Wire a sample into this test.', 'subject');
    tests.push({ key: item.key, values: item.values, workState: item.workState, subjects: subjectRefs });
  }

  // -- required for done, and the warnings ----------------------------------------------------------------------------------
  const needDone = (kind, collection, item) => {
    if (item.workState !== 'done') return;
    for (const { field, label } of required[collection] ?? []) {
      if (RESERVED_FIELDS[kind].includes(field) || blockedFields.has(`${item.key}|${field}`)) continue;
      if (isBlank(item.values[field])) block(item.key, `${label} is required.`, field);
    }
  };
  for (const item of items) {
    if (!isNew(item) || !live(item) || byKey.get(item.key) !== item || item.kind === 'sample') continue;
    const collection = KIND_COLLECTION[item.kind];
    needDone(item.kind, collection, item);
    if (isBlank(item.values.equipment_id)) warn(item.key, 'No machine chosen.', 'equipment_id');
    if (item.workState === 'planned' && isBlank(item.values.planned_date)) warn(item.key, 'No planned date.', 'planned_date');
  }

  // -- records that exist already -------------------------------------------------------------------------------------------
  const edits = [];
  const removals = { tests: [], operations: [], samples: [] };
  const deleting = { operations: new Set(), tests: new Set(), samples: new Map() }; // sample id -> the card that causes it
  for (const item of items) {
    if (!item.existing || byKey.get(item.key) !== item) continue;
    const row = stored(item);
    if (!row) {
      if (item.remove) warn(item.key, 'This record is already gone; there is nothing to remove.');
      else block(item.key, 'This record no longer exists, or you can no longer see it.');
      continue;
    }
    const editing = !item.remove && (item.attach === true || hasValues(item));
    if (Number(row.version) !== item.existing.version) {
      if (editing) block(item.key, 'Changed since you added it. Your edits were made against an older version, so review it first.');
      else warn(item.key, 'Changed since you added it — review.');
    }
    if (item.attach && !isBlank(row.sample_id)) block(item.key, 'It got an input in the meantime, so it cannot be attached any more.');
    if (item.remove) {
      const state = item.kind === 'sample' ? row.current_status : row.work_state;
      if (state !== 'planned') {
        block(item.key, 'Done records are never deleted from the map.');
        continue;
      }
      const id = lower(item.existing.id);
      if (item.kind === 'test') {
        removals.tests.push({ key: item.key, id });
        deleting.tests.add(id);
      } else if (item.kind === 'operation') {
        removals.operations.push({ key: item.key, id });
        deleting.operations.add(id);
        const out = row.output_sample_id ? lower(row.output_sample_id) : null;
        if (out && outputsInfo.get(out)?.status === 'planned' && !deleting.samples.has(out)) deleting.samples.set(out, item.key);
      } else {
        deleting.samples.set(id, item.key);
      }
    } else if (hasValues(item) && !item.attach) {
      edits.push({ key: item.key, collection: KIND_COLLECTION[item.kind], id: lower(item.existing.id), version: item.existing.version, values: item.values });
    }
  }
  // Samples that go (explicitly, or as the planned outputs of a removed operation): nothing may hang off them.
  for (const [sid, cause] of deleting.samples) {
    const code = outputsInfo.get(sid)?.code ?? existing.get(sid)?.sample_code ?? 'the sample';
    const hanging = refs.filter((r) => r.sampleIds.map(lower).includes(sid)
      && !(r.kind === 'operation' ? deleting.operations : deleting.tests).has(lower(r.id)));
    if (hanging.some((r) => r.work_state === 'done')) block(cause, `Something done hangs off ${code}, so it cannot be removed.`);
    else if (hanging.length) block(cause, `Something planned still hangs off ${code}. Remove that too.`);
    for (const r of records) if (r.input === `id:${sid}` || r.output === `id:${sid}`) block(r.itemKey, `This is wired to ${code}, which is being removed.`);
    for (const t of tests) if (t.subjects.includes(`id:${sid}`)) block(t.key, `This is wired to ${code}, which is being removed.`);
  }
  for (const item of items) {
    if (item.kind === 'sample' && item.remove && item.existing && deleting.samples.get(lower(item.existing.id)) === item.key) {
      removals.samples.push({ key: item.key, id: lower(item.existing.id) });
    }
  }
  for (const [sid, cause] of deleting.samples) {
    if (!removals.samples.some((s) => s.id === sid)) removals.samples.push({ key: cause, id: sid });
  }

  const batches = [];
  for (const r of records) if (r.batchKey && !batches.some((b) => b.key === r.batchKey)) batches.push({ key: r.batchKey, workState: r.workState, values: r.values });

  return {
    checks,
    plan: { removals, edits, samples, batches, operations: ordered.order, tests },
  };
}

export const computeChecks = (body, ctx) => buildPlan(body, ctx).checks;

// ---- the endpoint ----------------------------------------------------------------------------------------------------

const draftOut = (r) => ({
  id: r.draft_id,
  name: r.name,
  body: typeof r.body === 'string' ? JSON.parse(r.body) : r.body,
  version: Number(r.version),
  updated_at: toIso(r.updated_at),
});

export function mount(router, context, clock = () => new Date()) {
  const { database, logger, services, getSchema } = context;

  const sendError = (res, err) => {
    const known = err instanceof HttpError;
    if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    return res.status(known ? err.status : 500).json({
      errors: [{
        message: known ? err.message : 'Something went wrong on the server.',
        extensions: { ...(known ? err.extra : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
      }],
    });
  };
  // Routes: need a signed-in user, hand the handler the request, turn every failure into a Directus-shaped answer.
  const route = (fn) => async (req, res) => {
    try {
      const acc = req.accountability;
      if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
      await fn({ req, res, acc });
    } catch (err) {
      sendError(res, err);
    }
  };
  const idParam = (req, what) => {
    const id = req.params?.id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new HttpError(404, 'NOT_FOUND', `That ${what} does not exist.`);
    return id.toLowerCase();
  };

  // -- what the database knows about a draft (reads as the caller) ---------------------------------------------------

  const isDenied = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';
  const schemaOf = async (req) => req.schema ?? (await getSchema());
  const itemsFor = (schema, acc, collection, knex) =>
    new services.ItemsService(collection, { schema, accountability: acc, ...(knex ? { knex } : {}) });

  // The draft's existing records, read through ItemsService as the caller (the real read rules decide: a record the caller
  // cannot read is "gone"), then the samples those records work on (for inheritance), the fields the forms mark required, and,
  // for what a draft removes, the planned outputs and everything that points at them. `db` / `knex` are the transaction when
  // Create calls this.
  async function loadContext(req, body, { db = database, knex } = {}) {
    const schema = await schemaOf(req);
    const acc = req.accountability;
    const read = async (collection, ids) => {
      if (!ids.length) return [];
      try {
        return await itemsFor(schema, acc, collection, knex).readByQuery({
          fields: READ_FIELDS[collection],
          filter: { [COLLECTION_PK[collection]]: { _in: ids } },
          limit: ids.length,
        });
      } catch (err) {
        if (isDenied(err)) return [];
        throw err;
      }
    };
    const existing = new Map();
    const take = (collection, rows) => {
      for (const r of rows ?? []) existing.set(lower(r[COLLECTION_PK[collection]]), { ...r, _collection: collection });
    };
    const ids = { physical_samples: new Set(), manufacturing_operations: new Set(), test_sessions: new Set() };
    for (const item of body.items) if (item.existing) ids[KIND_COLLECTION[item.kind]].add(lower(item.existing.id));
    for (const collection of Object.keys(ids)) take(collection, await read(collection, [...ids[collection]]));
    const more = new Set();
    for (const r of existing.values()) {
      if (r._collection !== 'manufacturing_operations') continue;
      for (const f of ['sample_id', 'output_sample_id']) {
        if (r[f] && !existing.has(lower(r[f]))) more.add(lower(r[f]));
      }
    }
    take('physical_samples', await read('physical_samples', [...more]));

    const required = parseRequired(rowsOf(await db.raw(SQL.requiredFields)));

    // Samples a removal would delete: the removed samples, and the output of each removed operation.
    const candidates = new Set();
    for (const item of body.items) {
      if (!item.remove || !item.existing) continue;
      if (item.kind === 'sample') candidates.add(lower(item.existing.id));
      const out = item.kind === 'operation' ? existing.get(lower(item.existing.id))?.output_sample_id : null;
      if (out) candidates.add(lower(out));
    }
    const outputs = new Map();
    const refs = [];
    if (candidates.size) {
      const csv = [...candidates].join(',');
      for (const r of rowsOf(await db.raw(SQL.sampleInfo, [csv]))) {
        outputs.set(lower(r.sample_id), { code: r.sample_code, status: r.current_status });
      }
      for (const r of rowsOf(await db.raw(SQL.refsOperations, [csv, csv]))) {
        refs.push({
          kind: 'operation', id: r.operation_id, work_state: r.work_state,
          sampleIds: [r.sample_id, r.output_sample_id].filter(Boolean).map(lower),
        });
      }
      const tests = new Map();
      for (const r of [...rowsOf(await db.raw(SQL.refsTests, [csv])), ...rowsOf(await db.raw(SQL.refsSubjects, [csv]))]) {
        const t = tests.get(r.session_id) ?? { kind: 'test', id: r.session_id, work_state: r.work_state, sampleIds: [] };
        if (r.sample_id) t.sampleIds.push(lower(r.sample_id));
        tests.set(r.session_id, t);
      }
      refs.push(...tests.values());
    }
    return { existing, required, outputs, refs };
  }

  // -- drafts -----------------------------------------------------------------------------------------------------

  router.get('/drafts', route(async ({ res, acc }) => {
    const rows = rowsOf(await database.raw(SQL.listDrafts, [acc.user]));
    res.json({
      data: rows.map((r) => ({
        id: r.draft_id,
        name: r.name,
        updated_at: toIso(r.updated_at),
        summary: summarise(typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
      })),
    });
  }));

  router.post('/drafts', route(async ({ req, res, acc }) => {
    const b = req.body;
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { name?, body }.');
    const body = validateDraftBody(b.body);
    if (!body.ok) throw new HttpError(400, 'INVALID_PAYLOAD', body.message);
    let name = `Draft · ${clock().toISOString().slice(0, 10)}`;
    if (b.name !== undefined && b.name !== null) {
      const n = validateName(b.name);
      if (!n.ok) throw new HttpError(400, 'INVALID_PAYLOAD', n.message);
      name = n.name;
    }
    const [row] = rowsOf(await database.raw(SQL.insertDraft, [acc.user, name, JSON.stringify(body.body)]));
    res.status(201).json({ data: draftOut(row) });
  }));

  router.get('/drafts/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const [row] = rowsOf(await database.raw(SQL.getDraft, [id, acc.user]));
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    res.json({ data: draftOut(row) });
  }));

  router.patch('/drafts/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const b = req.body;
    if (!isObject(b)) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a JSON body with { name?, body?, version }.');
    if (!isInt(b.version, 1)) throw new HttpError(400, 'INVALID_PAYLOAD', 'version must be the version this save was made against.');
    if (b.name === undefined && b.body === undefined) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a name or a body to save.');
    let name = null;
    if (b.name !== undefined) {
      const n = validateName(b.name);
      if (!n.ok) throw new HttpError(400, 'INVALID_PAYLOAD', n.message);
      name = n.name;
    }
    let body = null;
    if (b.body !== undefined) {
      const v = validateDraftBody(b.body);
      if (!v.ok) throw new HttpError(400, 'INVALID_PAYLOAD', v.message);
      body = JSON.stringify(v.body);
    }
    const [row] = rowsOf(await database.raw(SQL.updateDraft, [name, body, id, acc.user, b.version]));
    if (row) return res.json({ data: draftOut(row) });
    // Nothing changed: the draft is not the caller's (or gone), or another save came first.
    const [there] = rowsOf(await database.raw(SQL.getDraft, [id, acc.user]));
    if (!there) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    throw new HttpError(409, 'CONFLICT', 'This draft changed in another tab. Reload it to see the latest version.');
  }));

  router.delete('/drafts/:id', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const out = await database.raw(SQL.deleteDraft, [id, acc.user]);
    if (!(out?.rowCount > 0)) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    res.status(204).end();
  }));

  // -- checks (spec E5, E13) -----------------------------------------------------------------------------------------

  router.post('/drafts/:id/check', route(async ({ req, res, acc }) => {
    const id = idParam(req, 'draft');
    const [row] = rowsOf(await database.raw(SQL.getDraft, [id, acc.user]));
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That draft does not exist.');
    const body = draftOut(row).body;
    const ctx = await loadContext(req, body);
    res.json({ data: { checks: buildPlan(body, ctx).checks } });
  }));
}

export default {
  id: SOURCE,
  handler: (router, context) => mount(router, context),
};
