// d1-bulk-actions: reading a record's state in the shape of the journal's `before` and `after` (spec "State snapshots"), so that "unchanged
// since" is a plain comparison.
//
// Ownership, access, restrict and unrestrict keep { owner_person_id, owner_team_id, restricted, people, teams }: a person's OWN rows (never derived
// team rows or the database-held owner grant) and a team's grants. A field edit keeps { <field>: <value> }.

import { BULK_FIELDS, HttpError, NOT_FOUND_REASON, ROLE_RANK, isBlank, normaliseValue, toBool } from './rules.js';

// `ops`: makeAccessOps(context); `services`: the Directus services.
export function makeSnapshots({ ops, services }) {
  const itemsFor = ops.itemsFor; // as the caller (Directus's permissions and filter hooks decide)
  // as the system: no permission rule hides a field from the journal
  const systemItems = (req, collection, knex) => new services.ItemsService(collection, { schema: req.schema, ...(knex ? { knex } : {}) });

  const snapshotFields = (cfg, kind, params) => (kind === 'edit_field' ? [params.field] : [cfg.ownerField, ...(cfg.ownerTeam ? ['owner_team_id'] : []), 'restricted']);

  // The record's fields. A field edit reads as the CALLER, so a field Directus hides from them (a 403) makes the record a skip and its value is
  // never journaled; the ownership columns are read as the system (the caller may not see who is on the access list, and the journal returns
  // those snapshots to administrators only).
  async function readRecord(trx, req, cfg, id, fields, asCaller) {
    const service = asCaller ? itemsFor(req, cfg.collection, trx) : systemItems(req, cfg.collection, trx);
    const row = await service.readOne(id, { fields });
    if (!row) throw new HttpError(404, 'NOT_FOUND', NOT_FOUND_REASON);
    return row;
  }

  // Row lock for the rest of the transaction: a concurrent edit waits instead of slipping in between the snapshot and the write.
  const lockRecord = (trx, cfg, id) => trx(cfg.collection).where(cfg.key, id).forUpdate().first(cfg.key);

  // The state of one record.
  async function snapshot(trx, req, cfg, id, kind, params) {
    const rec = await readRecord(trx, req, cfg, id, snapshotFields(cfg, kind, params), kind === 'edit_field');
    if (kind === 'edit_field') {
      const def = BULK_FIELDS[cfg.collection][params.field];
      return { [params.field]: normaliseValue(def.kind, rec[params.field]) };
    }
    const ownerId = rec[cfg.ownerField];
    // a person's OWN list entry: the access row, or the old co-owner row (samples) read as the role it stands for; the stronger one when both exist
    const own = new Map();
    const put = (personId, role) => {
      const key = String(personId).toLowerCase();
      if (!own.has(key) || (ROLE_RANK[role] ?? 0) > (ROLE_RANK[own.get(key)] ?? 0)) own.set(key, role);
    };
    for (const r of await trx(cfg.table).where(cfg.fk, id).whereNull('team_access_id').select('person_id', 'role')) {
      if (r.role !== 'own' && String(r.person_id) !== String(ownerId ?? '')) put(r.person_id, r.role);
    }
    if (cfg.legacy) {
      const logins = (await trx(cfg.legacy.table).where(cfg.legacy.fk, id).select('user_id')).map((r) => r.user_id).filter((v) => !isBlank(v));
      if (logins.length) {
        for (const p of await trx('people').whereIn('user_id', logins).select('person_id')) {
          if (String(p.person_id) !== String(ownerId ?? '')) put(p.person_id, cfg.legacy.role);
        }
      }
    }
    const people = [...own].map(([person_id, role]) => ({ person_id, role })).sort((a, b) => a.person_id.localeCompare(b.person_id));
    const teams = (await trx(ops.grantTable(cfg)).where(cfg.fk, id).select('team_id', 'role', 'trust_new_members'))
      .filter((r) => r.role !== 'own')
      .map((r) => ({ team_id: String(r.team_id).toLowerCase(), role: r.role, trust_new_members: toBool(r.trust_new_members) }))
      .sort((a, b) => a.team_id.localeCompare(b.team_id));
    return {
      owner_person_id: isBlank(ownerId) ? null : String(ownerId).toLowerCase(),
      owner_team_id: cfg.ownerTeam && !isBlank(rec.owner_team_id) ? String(rec.owner_team_id).toLowerCase() : null,
      restricted: toBool(rec.restricted),
      people,
      teams,
    };
  }

  return { itemsFor, readRecord, lockRecord, snapshot };
}
