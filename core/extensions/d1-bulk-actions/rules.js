// d1-bulk-actions: the pure rules (no database, no Directus): the kinds, the allow-list of editable fields, how a value is checked and
// compared, the snapshot comparison, the plan of a kind, and the plain words a skip or a preview warning uses.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The ownership and access kinds run through d1-record-access's extracted bodies; the others update the record as the caller.
export const ACCESS_KINDS = ['assign_team', 'change_owner', 'share_access', 'remove_access'];
export const KINDS = ['restrict', 'unrestrict', 'edit_field', ...ACCESS_KINDS];
// The kinds that tell someone (a summary email, held until the undo window closes); remove access, restrict and edit a field mail nobody.
export const MAILING_KINDS = ['assign_team', 'change_owner', 'share_access'];
export const isAccessKind = (kind) => ACCESS_KINDS.includes(kind);

export const isBlank = (v) => v === undefined || v === null || v === '';
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 't';
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const { hasOwn } = Object;
export const iso = (v) => {
  if (isBlank(v)) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
export const firstOf = (row, fields) => {
  for (const field of fields) if (!isBlank(row?.[field]) && String(row[field]).trim() !== '') return String(row[field]);
  return null;
};
export const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
export const sameUser = (a, b) => !isBlank(a) && !isBlank(b) && String(a).toLowerCase() === String(b).toLowerCase();
export const ROLE_RANK = { view: 1, edit: 2, investigator: 2 };
export const isForbidden = (e) => e?.status === 403 || e?.code === 'FORBIDDEN';

// The endpoint's own errors (a request that is wrong, a record that is gone), told apart from d1-record-access's, which are a record's skip reasons.
export class HttpError extends Error {
  constructor(status, code, message, extensions = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extensions = extensions;
  }
}
// Thrown inside a row's transaction to roll it back on purpose (a preview, a record that is skipped, already as asked, or failed).
export class Rollback extends Error {}
// Thrown when an undo or revert of an access change did not end exactly where it began: that record's transaction is rolled back.
export class Mismatch extends Error {}

// The fields a bulk edit may set, per collection: { field: { kind, label, clearable, values?, relation? } }. The server's own allow-list, mirrored by
// `bulkFields` of the index pages (packages/d1-ui/src/index/indexConfig.ts); the value is validated against the kind, then Directus's permissions
// and d1-access-guard decide per record. `clearable` is false for NOT NULL columns. `values` are the database's CHECK values. Left out on purpose:
// session_date and operation_date (timestamps), work_state and process_category (they change through Mark done and the builder), campaigns.status
// (no CHECK, so no known values), 'planned' as a sample status (it leaves when its operation is marked done), free text.
export const BULK_FIELDS = {
  physical_samples: {
    current_status: { kind: 'enum', label: 'Status', clearable: false, values: ['active', 'consumed', 'destroyed', 'archived'] },
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    mounted: { kind: 'bool', label: 'Mounted', clearable: true },
    manufactured_date: { kind: 'date', label: 'Manufactured date', clearable: true },
  },
  manufacturing_operations: {
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    campaign_id: { kind: 'relation', label: 'Campaign', clearable: true, relation: { collection: 'campaigns', key: 'campaign_id' } },
    planned_date: { kind: 'date', label: 'Planned date', clearable: true },
  },
  test_sessions: {
    status: { kind: 'enum', label: 'Status', clearable: false, values: ['registered', 'pending_processing', 'processing', 'processed', 'analysing', 'analysed', 'failed'] },
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    campaign_id: { kind: 'relation', label: 'Campaign', clearable: true, relation: { collection: 'campaigns', key: 'campaign_id' } },
    planned_date: { kind: 'date', label: 'Planned date', clearable: true },
  },
  campaigns: {
    project_id: { kind: 'relation', label: 'Project', clearable: true, relation: { collection: 'projects', key: 'project_id' } },
    start_date: { kind: 'date', label: 'Start date', clearable: true },
    end_date: { kind: 'date', label: 'End date', clearable: true },
  },
};

// ---- plain words -------------------------------------------------------------------------------------------------

export const NOT_FOUND_REASON = 'That record does not exist, or you cannot see it.';
export const NO_PERMISSION_REASON = 'You do not have permission to change this record.';
export const FAILED_REASON = 'Something went wrong changing this record.';
export const NOT_OWNER_REASON = 'You are not the owner of this record.';
export const OWNER_REMOVE_REASON = 'That person is the owner of this record, so their access cannot be removed. Change the owner instead.';
export const NOT_OWNABLE_REASON = 'A team cannot own this kind of record.';
// what an undo or revert says when the rules no longer allow putting a record back (Rulings O4 and O5)
export const REVERT_NOT_MANAGER = 'You can no longer manage this record, so it cannot be handed back. Ask an administrator to revert it.';
export const REVERT_NO_MANAGER = 'The team that owned this record has no manager now, so it cannot be handed back.';
export const REVERT_NO_OWNER = 'This record had no owner, so the owner cannot be put back automatically.';
export const REVERT_MISMATCH = 'The record could not be put back exactly as it was, so it was left alone.';
export const CHANGED_SINCE_REASON = 'Changed since this action ran, so it was left alone.';

// Preview warnings (Ruling O5): plain words, the same for every record they apply to (the dialog lists each distinct one once).
export const WARN_TEAM_MANAGERS_LOSE = 'The managers of the team that owns it now do not keep their access.';
export const WARN_YOU_LOSE_MANAGE = 'You will no longer be able to manage this record yourself, so an undo may be refused.';
export const warnBlocked = (name, blocked) =>
  blocked?.reason === 'no_login'
    ? `${name} has no D1 login yet, so they cannot open this record.`
    : `${name} cannot open this record yet: something it sits under is hidden from them.`;

// ---- values and snapshots ----------------------------------------------------------------------------------------

// A value as the snapshots and comparisons hold it: blank is null, a yes/no is a boolean, a date is YYYY-MM-DD, an id is lower case.
export function normaliseValue(kind, value) {
  if (isBlank(value)) return null;
  if (kind === 'bool') return toBool(value);
  if (kind === 'date') {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
  if (kind === 'relation') return String(value).toLowerCase();
  return String(value);
}

// JSON with sorted keys: two snapshots are equal when their canonical text is (jsonb reorders keys, so a plain stringify would not do).
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}
export const snapshotsEqual = (a, b) => canonical(a) === canonical(b);

// Validates the shape of a value against a field's kind and returns it normalised; throws a message (string) when it is wrong.
// Relations are checked against the database separately (the caller must be able to read the target).
export function checkValue(def, value) {
  if (value === null) {
    if (!def.clearable) throw new Error(`${def.label} cannot be cleared.`);
    return null;
  }
  if (def.kind === 'enum') {
    if (typeof value !== 'string' || !def.values.includes(value)) throw new Error(`${def.label} must be one of: ${def.values.join(', ')}.`);
    return value;
  }
  if (def.kind === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`${def.label} must be yes or no.`);
    return value;
  }
  if (def.kind === 'date') {
    const ok = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!ok) throw new Error(`${def.label} must be a date as YYYY-MM-DD.`);
    return value;
  }
  if (def.kind === 'relation') {
    if (!isUuid(value)) throw new Error(`${def.label} must be an id.`);
    return value.toLowerCase();
  }
  throw new Error(`${def.label} cannot be edited in bulk.`);
}

// What a kind does to one record: the update payload and the snapshot test for "already as asked".
//   { payload, noop(before) }; an access kind has no plan of its own (runAccess decides noop itself): { access: true }
export function planFor(kind, params, fieldDef) {
  if (isAccessKind(kind)) return { access: true };
  if (kind === 'restrict' || kind === 'unrestrict') {
    const want = kind === 'restrict';
    return { payload: { restricted: want }, noop: (before) => before.restricted === want };
  }
  const { field } = params;
  const value = normaliseValue(fieldDef.kind, params.value);
  return { payload: { [field]: value }, noop: (before) => before[field] === value };
}
