// d1-bulk-actions: the ownership and access kinds (assign_team, change_owner, share_access, remove_access) for one record, and putting them back.
// Every write is one of d1-record-access's own bodies (makeAccessOps), never a copy of its rules: the rules (can-manage, Ruling O3/O4/O5, the old-table
// cleanup, the readers triggers) live there. A refusal comes out as d1-record-access's HttpError and becomes the row's skip reason.

import { HttpError as AccessError } from '../d1-record-access/index.js';
import {
  Mismatch, NOT_OWNABLE_REASON, OWNER_REMOVE_REASON, REVERT_NO_OWNER, WARN_TEAM_MANAGERS_LOSE, WARN_YOU_LOSE_MANAGE, firstOf, snapshotsEqual, warnBlocked,
} from './rules.js';

// `ops`: makeAccessOps(context); `snapshot`: from makeSnapshots; `warn`: logs one line.
export function makeAccess({ ops, snapshot, warn }) {
  // What an ownership change costs the caller (Ruling O5), worked out after the change inside the transaction that a preview rolls back.
  async function transferWarnings(trx, args, before) {
    const out = [];
    const me = await ops.callerName(trx, args.acc);
    // the acting person managed it through the team that owned it: that team's managers are not kept
    if (before.owner_team_id && me.personId
      && (await trx('team_members').where({ team_id: before.owner_team_id, person_id: me.personId, is_manager: true }).first('person_id'))) out.push(WARN_TEAM_MANAGERS_LOSE);
    if (!(await ops.canManage(args, trx))) out.push(WARN_YOU_LOSE_MANAGE);
    return out;
  }

  // Inside the record's transaction (the row is locked and `before` is read): the caller must manage the record (a refusal is a skip), then the kind's
  // own rules, then the write. Returns { noop: true } (already as asked, nothing written) or { noop: false, warning? }; only a preview works out the
  // warning.
  async function runAccess(trx, ctx, id, before, preview) {
    const { req, acc, cfg, kind, params } = ctx;
    const args = { req, acc, cfg, id };
    await ops.requireManage(args, trx);
    const warnings = [];
    if (kind === 'assign_team') {
      if (!cfg.ownerTeam) throw new AccessError(409, 'NOT_OWNABLE_BY_TEAM', NOT_OWNABLE_REASON);
      if (before.owner_team_id === params.team_id) return { noop: true };
      await ops.transfer(trx, args, { team_id: params.team_id });
      if (preview) warnings.push(...(await transferWarnings(trx, args, before)));
    } else if (kind === 'change_owner') {
      if (before.owner_person_id === params.person_id) return { noop: true };
      const done = await ops.transfer(trx, args, { person_id: params.person_id });
      if (preview) {
        warnings.push(...(await transferWarnings(trx, args, before)));
        try {
          const stop = await ops.blockedFor(trx, cfg, id, done.record, done.next, acc);
          if (stop) warnings.push(warnBlocked(firstOf(done.next, ['full_name']) ?? 'The new owner', stop));
        } catch (err) {
          warn(`could not tell whether the new owner can open ${cfg.collection} ${id}: ${err?.message || err}`);
        }
      }
    } else if (kind === 'share_access' && params.person_id) {
      if (before.owner_person_id === params.person_id) await ops.addPerson(trx, args, { person_id: params.person_id, role: params.role }); // refuses: the owner already
      const person = await ops.personById(trx, params.person_id);
      const had = person ? await ops.rowsOf(trx, cfg, id, person) : { access: null, legacy: null };
      const level = had.access?.role ?? (had.legacy ? cfg.legacy.role : null);
      if (level === params.role) return { noop: true };
      if (level) await ops.changePersonRole(trx, args, { person_id: params.person_id, role: params.role });
      else await ops.addPerson(trx, args, { person_id: params.person_id, role: params.role });
    } else if (kind === 'share_access') {
      const grant = await ops.grantOf(trx, cfg, id, params.team_id);
      const listed = grant && grant.role !== 'own'; // the owning team is the owner, not a share (addTeam refuses it)
      if (listed && grant.role === params.role) return { noop: true };
      if (listed) await ops.changeTeam(trx, args, { team_id: params.team_id, patch: { role: params.role } });
      else await ops.addTeam(trx, args, { team_id: params.team_id, role: params.role });
    } else if (params.person_id) {
      // remove_access, a person
      const person = await ops.personById(trx, params.person_id);
      if (!person) return { noop: true };
      if (before.owner_person_id === params.person_id) throw new AccessError(409, 'CONFLICT', OWNER_REMOVE_REASON);
      const had = await ops.rowsOf(trx, cfg, id, person);
      if (!had.access && !had.legacy) return { noop: true };
      await ops.removePerson(trx, args, { person_id: params.person_id });
    } else {
      // remove_access, a team
      if (!(await ops.grantOf(trx, cfg, id, params.team_id))) return { noop: true };
      await ops.removeTeam(trx, args, { team_id: params.team_id }); // refuses the owning team (TEAM_OWNS_RECORD)
    }
    return { noop: false, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }

  // Undo and revert of an access change: from `current` (equal to what the action left) back to `before`, through the same bodies (no mail). The owner first
  // (a transfer keeps the previous person owner as Can edit and removes the new owner's own row, so the list is read again), then people, then team grants.
  // Refusals (the old owner team has no manager now; the caller cannot manage any more, Rulings O4 and O5) are thrown and become `refused`.
  async function restoreAccess(trx, args, current, before) {
    const { req, cfg, id } = args;
    let now = current;
    if (now.owner_team_id !== before.owner_team_id || now.owner_person_id !== before.owner_person_id) {
      if (before.owner_team_id) await ops.transfer(trx, args, { team_id: before.owner_team_id });
      else if (before.owner_person_id) await ops.transfer(trx, args, { person_id: before.owner_person_id });
      else throw new AccessError(409, 'CONFLICT', REVERT_NO_OWNER);
      now = await snapshot(trx, req, cfg, id, 'assign_team', {});
    }
    const haveP = new Map(now.people.map((p) => [p.person_id, p.role]));
    const wantP = new Map(before.people.map((p) => [p.person_id, p.role]));
    for (const personId of haveP.keys()) if (!wantP.has(personId)) await ops.removePerson(trx, args, { person_id: personId });
    for (const [personId, role] of wantP) {
      if (!haveP.has(personId)) await ops.addPerson(trx, args, { person_id: personId, role });
      else if (haveP.get(personId) !== role) await ops.changePersonRole(trx, args, { person_id: personId, role });
    }
    const haveT = new Map(now.teams.map((t) => [t.team_id, t]));
    const wantT = new Map(before.teams.map((t) => [t.team_id, t]));
    for (const teamId of haveT.keys()) if (!wantT.has(teamId)) await ops.removeTeam(trx, args, { team_id: teamId });
    for (const [teamId, want] of wantT) {
      const had = haveT.get(teamId);
      if (!had) {
        await ops.addTeam(trx, args, { team_id: teamId, role: want.role });
        if (want.trust_new_members) await ops.changeTeam(trx, args, { team_id: teamId, patch: { trust_new_members: true } });
      } else {
        const patch = {};
        if (had.role !== want.role) patch.role = want.role;
        if (had.trust_new_members !== want.trust_new_members) patch.trust_new_members = want.trust_new_members;
        if (Object.keys(patch).length) await ops.changeTeam(trx, args, { team_id: teamId, patch });
      }
    }
    if (!snapshotsEqual(await snapshot(trx, req, cfg, id, 'assign_team', {}), before)) throw new Mismatch();
  }

  return { runAccess, restoreAccess };
}
