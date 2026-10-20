// Directus endpoint: d1-bulk-actions  (mounted at /d1-bulk-actions)
//
// Bulk actions on the index pages (spec docs/superpowers/specs/2026-10-20-bulk-actions-design.md): one action on up to 100 ticked records, a dry-run
// preview per record, apply with partial success, a 60-second undo for the person who ran it, a revert for administrators, and the journal behind it
// (migration 204: bulk_actions, bulk_action_rows; read and written only here). Seven kinds: restrict, unrestrict and edit_field (an update of the record
// as the caller) and the ownership and access kinds assign_team, change_owner, share_access and remove_access, which run through d1-record-access's
// extracted bodies (makeAccessOps), so the access rules live in one place.
//
//   POST /d1-bulk-actions/:collection/preview   { kind, ids[], params }
//     -> { results: [{ id, code, status: 'ok'|'noop'|'skip', reason?, warning? }], counts: { total, ok, noop, skip } }
//        warning (a status 'ok' row of an ownership kind only): plain words saying what the change costs the caller (Ruling O5), the same for every row it
//        applies to, so the dialog can list each once.
//   POST /d1-bulk-actions/:collection/apply     { kind, ids[], params }
//     -> { action_id, undo_until, results: [{ id, code, outcome: 'applied'|'noop'|'skipped'|'failed', reason? }], counts: { total, applied, noop, skipped, failed } }
//   POST /d1-bulk-actions/:action_id/undo       -> { state, revert_action_id, results: [{ id, code, revert_outcome, reason? }] }
//        the person who ran it while now < undo_until, or an administrator
//   POST /d1-bulk-actions/:action_id/revert     -> the same shape; administrators only, any time
//   GET  /d1-bulk-actions                       -> { actions: [...], limit, offset, has_more }  (?limit=50 max 200, ?offset=0)
//   GET  /d1-bulk-actions/:action_id            -> { action, rows: [...] }  (before and after snapshots for administrators only)
//
// Errors (the Directus shape, source 'd1-bulk-actions'): 401; 403 READ_ONLY_ROLE (a Lab Viewer, on preview too); 400 INVALID_PAYLOAD, NOT_APPLICABLE;
// 404 NOT_FOUND (an action you may not see); 403 FORBIDDEN (revert by a non-administrator), UNDO_WINDOW_CLOSED; 409 CANNOT_REVERT_A_REVERT,
// ALREADY_REVERTED, NOTHING_TO_REVERT, STILL_APPLYING (an action's counts stay null until its apply has finished).
//
// Files: rules.js (kinds, field allow-list, words), request.js (the body), snapshot.js (before/after), access.js (the ownership and access kinds and
// putting them back), mail.js (the held summary mail), journal.js (the reads); this file wires them and runs one record, apply, undo and revert.
//
// Per record, preview and apply run the SAME function, and a preview runs in a transaction that is always rolled back, so the two cannot disagree:
//   1. a record the caller cannot read is skipped as "not found", with no code, never revealed;
//   2. in one transaction (d1.actor_identity set, so audit_logs names the caller): row lock, `before` snapshot, then the kind: an update as the CALLER
//      (Directus's permissions and d1-access-guard decide; the guard's refusal text is the skip reason) or, for the access kinds, the caller must manage
//      the record and one of d1-record-access's bodies runs; `after` snapshot. A value already as asked is `noop` and never written;
//   3. apply also writes the record's journal row in that transaction. Directus's action events (which cascade a project or campaign change) are held back
//      with `bypassEmitAction` and emitted after the commit; filter hooks, including d1-access-guard, still run.
// The data cache is cleared once per action when CACHE_ENABLED is on.
//
// Undo and revert are one implementation (spec 3.3): per applied row, a current snapshot that differs from `after` is `changed_since` (nothing written),
// otherwise `before` is written back as the caller (a refusal, such as Rulings O4 and O5: `refused`; a crash: `failed`). The revert is journaled as a new
// bulk_actions row (revert_of, mail_state 'none', undo_until = created_at so it can never be undone); the original becomes undone, reverted or
// partly_reverted (an administrator can revert a partly_reverted action again to retry the rest).
//
// Summary emails (spec 3.4, mail.js): assign_team mails the new team's managers, change_owner the new owner, share_access the person or the team's members
// with a login; one mail per recipient lists the codes, built from the journal when it is sent. Undo (or a revert that put everything back) cancels it.

import { COLLECTIONS, HttpError as AccessError, isLabViewer, isWriteRequest, makeAccessOps, READ_ONLY_ROLE_MESSAGE } from '../d1-record-access/index.js';
import { accountAdmin } from '../d1-people-admin/index.js';
import { makeAccess } from './access.js';
import { makeJournal } from './journal.js';
import { MAIL_GRACE_MS, makeMailer } from './mail.js';
import { makeRequests } from './request.js';
import {
  BULK_FIELDS, CHANGED_SINCE_REASON, FAILED_REASON, HttpError, MAILING_KINDS, Mismatch, NOT_FOUND_REASON, NOT_OWNER_REASON, NO_PERMISSION_REASON, REVERT_MISMATCH,
  REVERT_NOT_MANAGER, REVERT_NO_MANAGER, Rollback, firstOf, isAccessKind, isBlank, isForbidden, normaliseValue, parseJson, snapshotsEqual,
} from './rules.js';
import { makeSnapshots } from './snapshot.js';

export * from './rules.js';
export { summaryContent } from './mail.js';

const SOURCE = 'd1-bulk-actions';
const DEFAULT_LAB_ADMIN_ROLE_ID = '10000001-0000-0000-0000-000000000001';
const UNDO_WINDOW_MS = 60_000;

export default {
  id: SOURCE,
  handler: (router, context) => {
    mount(router, context);
  },
};

// `clock` is injectable for the tests (the undo window); so are `timers` (the per-action mail timer: { set, clear }; `sweep: false` skips the startup sweep).
// Returns { swept }: the promise of the startup sweep of overdue summary mails (for the tests).
export function mount(router, context, clock = () => new Date(), timers = {}) {
  const { database, logger, services, env, emitter } = context;
  const ops = makeAccessOps(context); // the rules of the access tables: the extracted bodies of d1-record-access, used as they are
  const warn = (message) => logger?.warn?.(`${SOURCE}: ${message}`);
  const labAdminRoleId = (typeof env?.D1_LAB_ADMIN_ROLE_ID === 'string' && env.D1_LAB_ADMIN_ROLE_ID.trim()) || DEFAULT_LAB_ADMIN_ROLE_ID;
  const { itemsFor, readRecord, lockRecord, snapshot } = makeSnapshots({ ops, services });
  const { runAccess, restoreAccess } = makeAccess({ ops, snapshot, warn });
  const prepare = makeRequests({ database, ops, itemsFor });
  const journal = makeJournal({ database });
  const mailer = makeMailer({
    context, ops, warn, clock, setTimer: timers.set ?? ((fn, ms) => setTimeout(fn, ms)), clearTimer: timers.clear ?? ((handle) => clearTimeout(handle)), undoWindowMs: UNDO_WINDOW_MS,
  });
  const { inTransaction } = ops; // sets the actor first, so the audit trigger names the caller

  const sendError = (res, err) => {
    const known = err instanceof HttpError;
    if (!known) logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    return res.status(known ? err.status : 500).json({
      errors: [{
        message: known ? err.message : 'Something went wrong on the server.',
        extensions: { ...(known ? err.extensions : {}), code: known ? err.code : 'INTERNAL_SERVER_ERROR', source: SOURCE },
      }],
    });
  };
  const route = (fn) => async (req, res) => {
    try {
      const acc = req.accountability;
      if (!acc?.user) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in first.');
      // a Lab Viewer changes nothing (preview is a POST that writes nothing, but there is nothing a viewer may preview)
      const labViewer = await isLabViewer(database, acc.user);
      if (labViewer && isWriteRequest(req)) throw new HttpError(403, 'READ_ONLY_ROLE', READ_ONLY_ROLE_MESSAGE);
      const caller = await accountAdmin(database, acc.user, labAdminRoleId);
      const admin = acc.admin === true || caller.admin;
      await fn({ req, res, acc, admin });
    } catch (err) {
      return sendError(res, err);
    }
  };

  // A journal row for an action (or a revert); returns its id (the driver answers an id or { action_id }).
  async function insertAction(db, acc, { params, ...row }) {
    const person = await db('people').where('user_id', acc.user).first('person_id');
    const [created] = await db('bulk_actions').insert({
      actor_user: String(acc.user), actor_person: person?.person_id ?? null, params: JSON.stringify(params), mail_state: 'none', mail_due_at: null, ...row,
    }).returning('action_id');
    return typeof created === 'object' && created !== null ? created.action_id : created;
  }

  // Directus's action events held back during a row's transaction, emitted once it has committed (as Directus does for its own writes).
  function emitAfterCommit(events) {
    for (const e of events) {
      try {
        emitter?.emitAction?.(e.event, e.meta, e.context);
      } catch (err) {
        warn(`an action event was not emitted: ${err?.message || err}`);
      }
    }
  }

  // false for a record the caller cannot read (the read rule decides) or that does not exist.
  async function readable({ req, cfg }, id) {
    try {
      return Boolean(await itemsFor(req, cfg.collection).readOne(id, { fields: [cfg.key] }));
    } catch (err) {
      if (isForbidden(err) || err?.status === 404) return false;
      throw err;
    }
  }

  // What went wrong with one record, as { outcome, reason }. The refusal text of d1-access-guard and d1-record-access is plain words made for the
  // person; Directus's own 403 gets one sentence of ours; Directus validation errors (a 4xx with a message) are shown as they are; anything else (a
  // database error) is logged and generic.
  function classify(err, phase = 'apply') {
    if (err instanceof AccessError) {
      if (err.code === 'FORBIDDEN') return { outcome: 'skipped', reason: phase === 'revert' ? REVERT_NOT_MANAGER : NOT_OWNER_REASON };
      if (err.code === 'TEAM_HAS_NO_MANAGER' && phase === 'revert') return { outcome: 'skipped', reason: REVERT_NO_MANAGER };
      if (err.status >= 500) {
        logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
        return { outcome: 'failed', reason: FAILED_REASON };
      }
      return { outcome: 'skipped', reason: err.message };
    }
    if (err instanceof Mismatch) return { outcome: 'failed', reason: REVERT_MISMATCH };
    if (isForbidden(err)) {
      const reason = err?.extensions?.source === 'd1-access-guard' && !isBlank(err.extensions.reason) ? String(err.extensions.reason) : NO_PERMISSION_REASON;
      return { outcome: 'skipped', reason };
    }
    if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500 && !isBlank(err.message) && typeof err.code !== 'number') {
      return { outcome: 'failed', reason: String(err.message) };
    }
    logger?.error?.(`${SOURCE}: ${err?.stack || err?.message || err}`);
    return { outcome: 'failed', reason: FAILED_REASON };
  }

  // -- one record, preview or apply -----------------------------------------------------------------------
  // `commit`: keep the change (apply) or roll it back (preview). `journal`: { action_id } writes the record's journal row inside the same
  // transaction. Returns { id, code, outcome, reason, warning, before, after, events }.
  async function runOne(ctx, id, { commit, journal: journalTo = null }) {
    const { req, acc, cfg, kind, params, plan } = ctx;
    const result = { id, code: null, outcome: 'skipped', reason: null, warning: null, before: null, after: null, events: [] };
    const alreadyAsAsked = () => {
      result.outcome = 'noop';
      result.after = result.before;
      throw new Rollback();
    };
    try {
      if (!(await readable(ctx, id))) {
        result.reason = NOT_FOUND_REASON;
        return result;
      }
      await inTransaction(acc, async (trx) => {
        await lockRecord(trx, cfg, id); // the snapshot and the write see the same row
        result.code = firstOf(await readRecord(trx, req, cfg, id, cfg.code, true), cfg.code); // the label, as the caller
        result.before = await snapshot(trx, req, cfg, id, kind, params);
        if (plan.access) {
          // a refusal is thrown (d1-record-access's HttpError) and rolls the record's transaction back
          const done = await runAccess(trx, ctx, id, result.before, !commit);
          if (done.noop) alreadyAsAsked();
          result.warning = done.warning ?? null;
        } else {
          if (plan.noop(result.before)) alreadyAsAsked();
          try {
            await itemsFor(req, cfg.collection, trx).updateOne(id, plan.payload, { bypassEmitAction: (e) => result.events.push(e), autoPurgeCache: false });
          } catch (err) {
            Object.assign(result, classify(err));
            throw new Rollback();
          }
        }
        result.after = await snapshot(trx, req, cfg, id, kind, params);
        if (snapshotsEqual(result.before, result.after)) {
          // Directus accepted it and nothing changed (a hook put it back): not an applied change
          result.outcome = 'noop';
          throw new Rollback();
        }
        result.outcome = 'applied';
        if (journalTo && commit) {
          await trx('bulk_action_rows').insert({
            action_id: journalTo.action_id, record_id: String(id), record_code: result.code, outcome: 'applied', reason: null,
            before: JSON.stringify(result.before), after: JSON.stringify(result.after),
          });
        }
        if (!commit) throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) {
        if (err instanceof HttpError && err.status === 404) Object.assign(result, { outcome: 'skipped', reason: NOT_FOUND_REASON });
        else Object.assign(result, classify(err));
      }
    }
    if (!commit || result.outcome !== 'applied') result.events = [];
    return result;
  }

  // -- preview -----------------------------------------------------------------------------------------
  router.post('/:collection/preview', route(async ({ req, res, acc }) => {
    const ctx = await prepare(req, acc);
    const results = [];
    const counts = { total: ctx.ids.length, ok: 0, noop: 0, skip: 0 };
    for (const id of ctx.ids) {
      const r = await runOne(ctx, id, { commit: false });
      const status = r.outcome === 'applied' ? 'ok' : r.outcome === 'noop' ? 'noop' : 'skip';
      counts[status] += 1;
      results.push({ id: r.id, code: r.code, status, ...(r.reason ? { reason: r.reason } : {}), ...(status === 'ok' && r.warning ? { warning: r.warning } : {}) });
    }
    res.json({ results, counts });
  }));

  // -- apply -------------------------------------------------------------------------------------------
  router.post('/:collection/apply', route(async ({ req, res, acc }) => {
    const ctx = await prepare(req, acc);
    const started = clock();
    // The action row first, so every record's journal row (written in that record's own transaction) has a parent. Its counts stay null until
    // the loop is over: undo and revert refuse an action that is still being applied (STILL_APPLYING).
    const actionId = await insertAction(database, acc, {
      collection: ctx.cfg.collection, kind: ctx.kind, params: ctx.params, created_at: started, undo_until: new Date(started.getTime() + UNDO_WINDOW_MS),
      n_applied: null, n_skipped: null, n_failed: null,
    });

    const results = [];
    const counts = { total: ctx.ids.length, applied: 0, noop: 0, skipped: 0, failed: 0 };
    const unjournaled = [];
    let undoUntil;
    let mailDue = null;
    try {
      for (const id of ctx.ids) {
        const r = await runOne(ctx, id, { commit: true, journal: { action_id: actionId } });
        counts[r.outcome] += 1;
        if (r.outcome === 'applied') emitAfterCommit(r.events);
        else {
          // snapshots are kept only for records that were changed
          unjournaled.push({ action_id: actionId, record_id: String(id), record_code: r.code, outcome: r.outcome, reason: r.reason ?? null, before: null, after: null });
        }
        results.push({ id: r.id, code: r.code, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
      }
    } finally {
      // Whatever happened, the counts are written so the action can be reverted. The window starts when the work is done (up to 100 records take a while).
      undoUntil = new Date(clock().getTime() + UNDO_WINDOW_MS);
      // The summary email is held until the window closes (plus a moment), and only when something changed and the kind tells someone.
      if (counts.applied && MAILING_KINDS.includes(ctx.kind)) mailDue = new Date(undoUntil.getTime() + MAIL_GRACE_MS);
      await database.transaction(async (trx) => {
        if (unjournaled.length) await trx('bulk_action_rows').insert(unjournaled);
        await trx('bulk_actions').where('action_id', actionId).update({
          n_applied: counts.applied, n_skipped: counts.skipped + counts.noop, n_failed: counts.failed, undo_until: undoUntil,
          ...(mailDue ? { mail_state: 'pending', mail_due_at: mailDue } : {}),
        });
      });
    }
    if (mailDue) mailer.schedule(actionId, mailDue, req.schema);
    if (counts.applied) await ops.clearDataCache(req);
    res.json({ action_id: actionId, undo_until: undoUntil.toISOString(), results, counts });
  }));

  // -- undo and revert -----------------------------------------------------------------------------------

  // One record of an undo or revert, in its own transaction. Returns { id, code, revert_outcome, reason, before, after, events }.
  async function revertOne(ctx, row) {
    const { req, acc, cfg, kind, params } = ctx;
    const out = { id: row.record_id, code: row.record_code ?? null, revert_outcome: 'failed', reason: null, before: null, after: null, events: [] };
    const fieldDef = kind === 'edit_field' ? (BULK_FIELDS[cfg.collection] ?? {})[params.field] : null;
    const before = parseJson(row.before);
    const after = parseJson(row.after);
    const refuse = (reason) => Object.assign(out, { revert_outcome: 'refused', reason });
    // what happened to this record, written to its journal row: inside the record's transaction when it commits, else on its own below
    const finish = (db) => db('bulk_action_rows').where({ action_id: row.action_id, record_id: row.record_id }).update({ revert_outcome: out.revert_outcome, revert_reason: out.reason });
    let journaled = false;
    try {
      if (kind === 'edit_field' && !fieldDef) {
        refuse('That field can no longer be edited in bulk.');
      } else if (!(await readable({ req, cfg }, row.record_id))) {
        refuse(NOT_FOUND_REASON);
      } else {
        await inTransaction(acc, async (trx) => {
          await lockRecord(trx, cfg, row.record_id); // compared and written under the row lock
          const current = await snapshot(trx, req, cfg, row.record_id, kind, params);
          out.before = current;
          if (!snapshotsEqual(current, after)) {
            Object.assign(out, { revert_outcome: 'changed_since', reason: CHANGED_SINCE_REASON, after: current });
          } else {
            if (isAccessKind(kind)) {
              // owner, access list and team grants go back through d1-record-access's bodies (no mail); a rule that forbids it now is a refusal
              await restoreAccess(trx, { req, acc, cfg, id: row.record_id }, current, before);
            } else {
              const payload = kind === 'edit_field'
                ? { [params.field]: normaliseValue(fieldDef.kind, before[params.field]) }
                : { restricted: before.restricted === true };
              try {
                await itemsFor(req, cfg.collection, trx).updateOne(row.record_id, payload, { bypassEmitAction: (e) => out.events.push(e), autoPurgeCache: false });
              } catch (err) {
                out.after = current;
                throw err;
              }
            }
            out.after = await snapshot(trx, req, cfg, row.record_id, kind, params);
            Object.assign(out, { revert_outcome: 'reverted', reason: null });
          }
          await finish(trx);
        });
        journaled = true; // the outcome committed with the record
      }
    } catch (err) {
      // a refusal or a failure rolled the record's transaction back
      const c = classify(err, 'revert');
      Object.assign(out, { revert_outcome: c.outcome === 'skipped' ? 'refused' : 'failed', reason: c.reason });
    }
    if (!journaled) {
      try {
        await finish(database);
      } catch (e) {
        warn(`could not journal the revert outcome of ${row.record_id}: ${e?.message || e}`);
      }
    }
    if (out.revert_outcome !== 'reverted') out.events = [];
    return out;
  }

  const ALREADY_REVERTED = () => new HttpError(409, 'ALREADY_REVERTED', 'That bulk action has already been undone or reverted.');

  // mode 'undo': the actor inside the window, or an administrator. mode 'revert': administrators, any time.
  async function undoOrRevert(c, mode) {
    const { req, res, acc, admin } = c;
    const actionId = req.params?.action_id;
    if (mode === 'revert' && !admin) throw new HttpError(403, 'FORBIDDEN', 'Only an administrator can revert a bulk action.');
    const finished = await database.transaction(async (lock) => {
      // The action row is locked for the whole run: a second undo or revert waits, then finds the state changed (409).
      const action = await journal.visibleAction(lock, c, true);
      if (action.n_applied === null || action.n_applied === undefined) throw new HttpError(409, 'STILL_APPLYING', 'That bulk action is still being applied. Try again in a moment.');
      if (!isBlank(action.revert_of)) throw new HttpError(409, 'CANNOT_REVERT_A_REVERT', 'A revert cannot be reverted. Run the action again instead.');
      const now = clock();
      if (mode === 'undo' && !admin && !(now.getTime() < new Date(action.undo_until).getTime())) {
        throw new HttpError(403, 'UNDO_WINDOW_CLOSED', 'The 60 seconds to undo have passed. Ask an administrator to revert it.');
      }
      // undone and reverted are final; applied and partly_reverted (a retry of what was changed since or refused) can go on
      if (action.state === 'undone' || action.state === 'reverted' || (mode === 'undo' && action.state !== 'applied')) throw ALREADY_REVERTED();
      const cfg = COLLECTIONS[action.collection];
      if (!cfg) throw new HttpError(400, 'INVALID_PAYLOAD', 'That kind of record has no bulk actions.');
      const { kind } = action;
      const params = parseJson(action.params) ?? {};
      const applied = (await lock('bulk_action_rows').where('action_id', actionId).select()).filter((r) => r.outcome === 'applied');
      const todo = applied.filter((r) => r.revert_outcome !== 'reverted');
      if (!applied.length) throw new HttpError(409, 'NOTHING_TO_REVERT', 'That bulk action has nothing left to revert.');
      if (!todo.length) {
        // every record is reverted but the state never got written (a crash after the records committed): put it right, then answer 409
        await lock('bulk_actions').where('action_id', actionId).update({ state: mode === 'undo' ? 'undone' : 'reverted', ...(action.mail_state === 'pending' ? { mail_state: 'cancelled' } : {}) });
        return { healed: true };
      }

      const ctx = { req, acc, cfg, kind, params };
      const outs = [];
      for (const row of todo) {
        const o = await revertOne(ctx, row);
        if (o.revert_outcome === 'reverted') emitAfterCommit(o.events);
        outs.push(o);
      }
      const count = (...kinds) => outs.filter((o) => kinds.includes(o.revert_outcome)).length;
      const revertedNow = count('reverted');
      const state = applied.length - todo.length + revertedNow === applied.length ? (mode === 'undo' ? 'undone' : 'reverted') : 'partly_reverted';

      // The revert is itself a journaled bulk action: same kind, linked to the original, never undone, mails nobody.
      const revertId = await insertAction(lock, acc, {
        collection: action.collection, kind, params, created_at: now, undo_until: now, state: 'applied', revert_of: actionId,
        n_applied: revertedNow, n_skipped: count('changed_since', 'refused'), n_failed: count('failed'),
      });
      await lock('bulk_action_rows').insert(outs.map((o) => ({
        action_id: revertId, record_id: String(o.id), record_code: o.code,
        outcome: o.revert_outcome === 'reverted' ? 'applied' : o.revert_outcome === 'failed' ? 'failed' : 'skipped',
        reason: o.reason,
        before: o.revert_outcome === 'reverted' ? JSON.stringify(o.before) : null,
        after: o.revert_outcome === 'reverted' ? JSON.stringify(o.after) : null,
      })));
      // The held summary mail is cancelled when the action ends undone or reverted (every changed record is back). An undo that was refused (Ruling O5: the
      // change stands) or only partly done leaves it pending: the mail then lists what is still so. This runs under the action's row lock, and the sender
      // claims the mail under the same lock, so one of the two wins and never both.
      const cancelMail = action.mail_state === 'pending' && (state === 'undone' || state === 'reverted');
      await lock('bulk_actions').where('action_id', actionId).update({ state, ...(cancelMail ? { mail_state: 'cancelled' } : {}) });
      return { state, revertId, outs, revertedNow, cancelMail };
    });
    if (finished.cancelMail) mailer.cancel(actionId);
    if (finished.healed) throw ALREADY_REVERTED();
    if (finished.revertedNow) await ops.clearDataCache(req);
    res.json({
      state: finished.state,
      revert_action_id: finished.revertId,
      results: finished.outs.map((o) => ({ id: o.id, code: o.code, revert_outcome: o.revert_outcome, ...(o.reason ? { reason: o.reason } : {}) })),
    });
  }
  router.post('/:action_id/undo', route((c) => undoOrRevert(c, 'undo')));
  router.post('/:action_id/revert', route((c) => undoOrRevert(c, 'revert')));

  journal.mountReads(router, route);

  const swept = timers.sweep === false ? Promise.resolve() : mailer.sweep().catch((err) => warn(`the sweep of held summary mails failed: ${err?.message || err}`));
  return { swept };
}
