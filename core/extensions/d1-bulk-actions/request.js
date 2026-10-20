// d1-bulk-actions: reading and checking the body of a preview or apply request. Everything here is decided before any record is touched.
//   params: restrict and unrestrict {}; edit_field { field, value } (null clears); assign_team { team_id }; change_owner { person_id };
//   share_access { person_id | team_id, role: 'view' | 'edit' }; remove_access { person_id | team_id }.

import { COLLECTIONS } from '../d1-record-access/index.js';
import { BULK_FIELDS, HttpError, KINDS, checkValue, hasOwn, isAccessKind, isForbidden, isObject, isUuid, planFor } from './rules.js';

export const MAX_IDS = 100;
const NOT_APPLICABLE = 'That action does not apply to this kind of record.';

const isCollection = (name) => typeof name === 'string' && hasOwn(COLLECTIONS, name);
const ownable = (cfg) => cfg.ownerTeam === true; // samples, operations, tests, campaigns (not projects)

// params of the access kinds. Ids are lower-cased (the snapshots hold them so).
function parseAccessParams(cfg, kind, given) {
  const ask = (key, label) => {
    if (!isUuid(given[key])) throw new HttpError(400, 'INVALID_PAYLOAD', `${key} must be ${label}.`);
    return given[key].toLowerCase();
  };
  if (kind === 'assign_team') return { team_id: ask('team_id', 'a team id') };
  if (kind === 'change_owner') return { person_id: ask('person_id', 'a person id') };
  const hasPerson = given.person_id !== undefined;
  const hasTeam = given.team_id !== undefined;
  if (hasPerson && hasTeam) throw new HttpError(400, 'INVALID_PAYLOAD', 'Send a person_id or a team_id, not both.');
  if (!hasPerson && !hasTeam) throw new HttpError(400, 'INVALID_PAYLOAD', 'Choose a person or a team.');
  const target = hasPerson ? { person_id: ask('person_id', 'a person id') } : { team_id: ask('team_id', 'a team id') };
  if (kind === 'remove_access') return target;
  if (given.role !== 'view' && given.role !== 'edit') throw new HttpError(400, 'INVALID_PAYLOAD', 'The access level must be view or edit.');
  if (!cfg.roles.includes(given.role)) throw new HttpError(400, 'INVALID_PAYLOAD', `The access level must be one of: ${cfg.roles.join(', ')}.`);
  return { ...target, role: given.role };
}

// The ids: a non-empty list of UUIDs, lower-cased and de-duplicated (the first one seen wins the place), at most MAX_IDS.
function parseIds(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'INVALID_PAYLOAD', 'Pick at least one record.');
  if (!raw.every(isUuid)) throw new HttpError(400, 'INVALID_PAYLOAD', 'One of the record ids is not valid.');
  const ids = [...new Set(raw.map((id) => id.toLowerCase()))]; // the readers tables and the snapshots hold lower-case UUIDs
  if (ids.length > MAX_IDS) throw new HttpError(400, 'INVALID_PAYLOAD', `Pick at most ${MAX_IDS} records at a time.`);
  return ids;
}

function parseRequest(req) {
  const collection = req.params?.collection;
  const cfg = isCollection(collection) ? COLLECTIONS[collection] : null;
  if (!cfg) throw new HttpError(400, 'INVALID_PAYLOAD', 'That kind of record has no bulk actions.');
  const body = isObject(req.body) ? req.body : {};
  const { kind } = body;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw new HttpError(400, 'INVALID_PAYLOAD', 'That action is not available.');
  // restrict, change owner, share and remove access are for the four ownable record types; assign to a team is accepted anywhere (a record that no team
  // can own is skipped per row, Ruling O3)
  if (kind !== 'edit_field' && kind !== 'assign_team' && !ownable(cfg)) throw new HttpError(400, 'NOT_APPLICABLE', NOT_APPLICABLE);
  if (kind === 'edit_field' && !hasOwn(BULK_FIELDS, cfg.collection)) throw new HttpError(400, 'NOT_APPLICABLE', NOT_APPLICABLE);
  const ids = parseIds(body.ids);
  const given = isObject(body.params) ? body.params : {};

  let params = {};
  let fieldDef = null;
  if (kind === 'edit_field') {
    const { field } = given;
    if (typeof field !== 'string' || !hasOwn(BULK_FIELDS[cfg.collection], field)) throw new HttpError(400, 'INVALID_PAYLOAD', 'That field cannot be edited in bulk.');
    if (!hasOwn(given, 'value')) throw new HttpError(400, 'INVALID_PAYLOAD', 'Say what to set the field to (null clears it).');
    fieldDef = BULK_FIELDS[cfg.collection][field];
    try {
      params = { field, value: checkValue(fieldDef, given.value) };
    } catch (err) {
      throw new HttpError(400, 'INVALID_PAYLOAD', err.message);
    }
  } else if (isAccessKind(kind)) {
    params = parseAccessParams(cfg, kind, given);
  }
  return { cfg, kind, ids, params, fieldDef };
}

// `ops`: makeAccessOps(context); `itemsFor(req, collection)`: the service as the caller. Returns `prepare(req, acc)`: the request, parsed and checked, with
// the kind's plan: { cfg, kind, ids, params, fieldDef, req, acc, plan }.
export function makeRequests({ database, ops, itemsFor }) {
  // The person or team the action points at must exist (and a person be active) before any record is touched, so one wrong choice is one 400, not a
  // skip on every row. Removing access needs neither: a person or team that is gone is simply not listed.
  async function checkTarget(kind, params) {
    if (kind === 'remove_access') return;
    if (params.team_id) {
      if (!(await database('teams').where('team_id', params.team_id).first('team_id'))) throw new HttpError(400, 'INVALID_PAYLOAD', 'That team does not exist.');
    } else if (params.person_id) {
      const person = await ops.personById(database, params.person_id);
      if (!person) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person does not exist.');
      if (person.active === false) throw new HttpError(400, 'INVALID_PAYLOAD', 'That person is not active.');
    }
  }

  // A relation value must be something the CALLER can read (else a person could probe for ids they may not see). Checked once per request.
  async function checkRelation(req, fieldDef, value) {
    if (fieldDef?.kind !== 'relation' || value === null) return;
    const { collection, key } = fieldDef.relation;
    let found = false;
    try {
      found = Boolean(await itemsFor(req, collection).readOne(value, { fields: [key] }));
    } catch (err) {
      if (!isForbidden(err) && err?.status !== 404) throw err;
    }
    if (!found) throw new HttpError(400, 'INVALID_PAYLOAD', `That ${fieldDef.label.toLowerCase()} does not exist, or you cannot see it.`);
  }

  return async function prepare(req, acc) {
    const parsed = parseRequest(req);
    await checkRelation(req, parsed.fieldDef, parsed.params.value);
    await checkTarget(parsed.kind, parsed.params);
    return { ...parsed, req, acc, plan: planFor(parsed.kind, parsed.params, parsed.fieldDef) };
  };
}
