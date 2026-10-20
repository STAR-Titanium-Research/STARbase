// d1-bulk-actions: the summary emails (spec 3.4), held until the undo window closes.
//
// At apply an action that tells someone is `pending` with mail_due_at = undo_until + 2 s, and a timer (one per action) sends it then. Undo (and a revert
// that put everything back) sets `cancelled` under the action's row lock. The sender CLAIMS the held mail under the same lock (pending -> sent, committed)
// before it sends, so an undo and a send can never both happen; a mail that fails afterwards is logged and never undoes the change (the claim stands: one
// try, never twice). On start a sweep sends every overdue pending action and re-arms the ones not yet due, so a restart only delays mail, it never loses it.

import { COLLECTIONS, PERSON_COLUMNS, escapeHtml, mailContent, recipientAddress, recordLink, roleLabel, withTimeout } from '../d1-record-access/index.js';
import { isBlank, parseJson } from './rules.js';

const MAIL_TIMEOUT_MS = 10_000;
export const MAIL_GRACE_MS = 2_000; // the summary mail is due this long after the undo window closes
const MAIL_LIST_MAX = 20; // codes listed in one summary mail, then "and N more"

const oneLine = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
// A transport's error text can quote the address it refused: a log line never carries one.
const redacted = (err) => String(err?.message || err).replace(/[^\s<>"',;()]+@[^\s<>"',;()]+/g, '[address]');

// ---- the content (pure) ------------------------------------------------------------------------------------------

// One mail to one recipient listing what an action gave them: { subject, text, html }. `items`: [{ code, link, blocked }] in the order to list; `blocked`
// means the recipient cannot read that record yet (no link is shown, as in the single-record mail; `blockedReason` 'parent' or 'no_login' words it).
// `mode`: 'team_owner' (a team was made the owner; the mail goes to its managers, `teamName`), 'owner' (the recipient was made the owner) or 'share'
// (the recipient was given access; `role` is the level in words, `teamName` when it comes through a team). One record reads exactly as the
// single-record mail of d1-record-access (mailContent); more list the first MAIL_LIST_MAX codes, then "and N more". Every value is HTML-escaped.
export function summaryContent({ adder, kind, items, mode, role = null, teamName = null, blockedReason = null }) {
  if (items.length === 1) {
    const [only] = items;
    return mailContent({
      adder, role, kind, code: only.code, title: null, link: only.blocked ? null : only.link, transfer: mode === 'owner', blockedReason: only.blocked ? blockedReason : null,
      via: mode === 'share' ? teamName : null, ownerTeam: mode === 'team_owner' ? teamName : null,
    });
  }
  const who = oneLine(adder) || 'Someone';
  const team = oneLine(teamName);
  const what = `${items.length} ${oneLine(kind)}s`;
  const phrase = mode === 'team_owner' ? `made the team ${team} the owner of ${what}` : mode === 'owner' ? `made you the owner of ${what}` : `gave you access to ${what}${team ? ` via ${team}` : ''}`;
  const listed = items.slice(0, MAIL_LIST_MAX);
  const more = items.length - listed.length;
  const roleLine = oneLine(role);
  const manager = mode === 'team_owner' ? `As a manager of ${team} you can share them, transfer them and delete them.` : null;
  const wait = items.some((i) => i.blocked)
    ? 'You cannot open some of them yet. You will be able to once you have a D1 login and access to what they sit under.'
    : null;
  const open = (i) => i.link && !i.blocked;
  const text = [
    `${who} ${phrase}.`,
    manager,
    mode === 'share' && roleLine ? `Your role: ${roleLine}.` : null,
    '',
    ...listed.map((i) => `- ${oneLine(i.code)}${open(i) ? `: ${i.link}` : ''}`),
    more > 0 ? `- and ${more} more` : null,
    wait ? '' : null,
    wait,
    '',
    'If you did not expect this, you can ignore this email.',
  ].filter((line) => line !== null).join('\n');
  const html = [
    `<p><strong>${escapeHtml(who)}</strong> ${escapeHtml(phrase)}.</p>`,
    manager ? `<p>${escapeHtml(manager)}</p>` : '',
    mode === 'share' && roleLine ? `<p>Your role: <strong>${escapeHtml(roleLine)}</strong>.</p>` : '',
    `<ul>${listed.map((i) => `<li>${open(i) ? `<a href="${escapeHtml(i.link)}">${escapeHtml(oneLine(i.code))}</a>` : escapeHtml(oneLine(i.code))}</li>`).join('')}${more > 0 ? `<li>and ${more} more</li>` : ''}</ul>`,
    wait ? `<p>${escapeHtml(wait)}</p>` : '',
    '<p>If you did not expect this, you can ignore this email.</p>',
  ].filter(Boolean).join('\n');
  return { subject: `${who} ${phrase}`, text, html };
}

// ---- the timers, the claim and the sweep -------------------------------------------------------------------------

// `deps`: { context ({ database, services, env, getSchema }), ops (makeAccessOps), warn, clock, setTimer, clearTimer }.
// Returns { schedule(actionId, dueAt, schema), cancel(actionId), sweep() }.
export function makeMailer({ context, ops, warn, clock, setTimer, clearTimer }) {
  const { database, services, env } = context;
  const timers = new Map();
  const keyOf = (actionId) => String(actionId).toLowerCase();

  function schedule(actionId, dueAt, schema) {
    const key = keyOf(actionId);
    if (timers.has(key)) clearTimer(timers.get(key));
    const handle = setTimer(() => {
      timers.delete(key);
      send(actionId, schema).catch((err) => warn(`the summary mail of bulk action ${actionId} failed: ${redacted(err)}`));
    }, Math.max(0, dueAt.getTime() - clock().getTime()));
    handle?.unref?.(); // a pending mail timer must never keep the process (or a test run) alive
    timers.set(key, handle);
  }

  function cancel(actionId) {
    const key = keyOf(actionId);
    if (!timers.has(key)) return;
    clearTimer(timers.get(key));
    timers.delete(key);
  }

  // Who is mailed, read now (a person removed since is not mailed): [{ person, mode, role, teamName }]
  async function recipientsOf(action, params, cfg) {
    const keep = (p) => p && p.active !== false && String(p.user_id ?? '') !== String(action.actor_user); // never the one who ran it
    const withLogin = (people) => people.filter((p) => keep(p) && !isBlank(p.user_id)); // like the single-record mail to a team: people with a login
    const teamOf = (id) => database('teams').where('team_id', id).first('team_id', 'name');
    const peopleOf = async (ids) => (ids.length ? database('people').whereIn('person_id', ids).select(...PERSON_COLUMNS) : []);
    if (action.kind === 'assign_team') {
      const team = await teamOf(params.team_id);
      if (!team) return [];
      const ids = (await database('team_members').where('team_id', team.team_id).where('is_manager', true).select('person_id')).map((m) => m.person_id);
      return withLogin(await peopleOf(ids)).map((person) => ({ person, mode: 'team_owner', role: null, teamName: team.name }));
    }
    if (action.kind === 'change_owner') {
      const person = await ops.personById(database, params.person_id);
      return keep(person) ? [{ person, mode: 'owner', role: ops.ownerLabel(cfg.collection), teamName: null }] : [];
    }
    if (action.kind !== 'share_access') return [];
    const role = roleLabel(cfg.collection, params.role);
    if (params.person_id) {
      const person = await ops.personById(database, params.person_id);
      return keep(person) ? [{ person, mode: 'share', role, teamName: null }] : [];
    }
    const team = await teamOf(params.team_id);
    if (!team) return [];
    const ids = (await database('team_members').where('team_id', team.team_id).select('person_id')).map((m) => m.person_id);
    return withLogin(await peopleOf(ids)).map((person) => ({ person, mode: 'share', role, teamName: team.name }));
  }

  // The records among `ids` this person can open now (their readers rows; an administrator opens all; a person with no login none)
  async function openableBy(person, cfg, ids) {
    if (isBlank(person.user_id)) return new Set();
    if (await ops.isAdminLogin(database, person.user_id)) return new Set(ids.map(String));
    const rows = await database(cfg.readers).whereIn('record_id', ids).where('user_id', person.user_id).select('record_id');
    return new Set(rows.map((r) => String(r.record_id)));
  }

  const heldKey = (personId, recordId) => `${String(personId)}|${String(recordId)}`.toLowerCase();
  // The people waiting for approval (or who declined) on a team's grant, per record, as "person|record": they have no access yet, so a share through the
  // team does not tell them they were given it (as in the single-record mail).
  async function heldOn(cfg, params, ids) {
    if (!params.team_id) return new Set();
    const grants = await database(ops.grantTable(cfg)).where('team_id', params.team_id).whereIn(cfg.fk, ids).select('team_access_id', cfg.fk);
    if (!grants.length) return new Set();
    const recordOf = new Map(grants.map((g) => [String(g.team_access_id), String(g[cfg.fk])]));
    const held = await database(ops.pendingTable(cfg)).whereIn('team_access_id', [...recordOf.keys()]).select('team_access_id', 'person_id');
    return new Set(held.map((h) => heldKey(h.person_id, recordOf.get(String(h.team_access_id)))));
  }

  // Like the Who-has-access routes, only a NEW grant is mailed: a changed level (a person or team already on the record's list before) tells nobody.
  function isNewGrant(row, params) {
    const before = parseJson(row.before) ?? {};
    return params.person_id
      ? !(before.people ?? []).some((p) => p.person_id === params.person_id)
      : !(before.teams ?? []).some((t) => t.team_id === params.team_id);
  }

  // Sends one mail per recipient, built from the journal now: what was applied and has not been put back since. `tally` counts sent, skipped, failed.
  async function deliver(action, schema, tally) {
    const cfg = COLLECTIONS[action.collection];
    const params = parseJson(action.params) ?? {};
    const rows = (await database('bulk_action_rows').where('action_id', action.action_id).select())
      .filter((r) => r.outcome === 'applied' && r.revert_outcome !== 'reverted' && (action.kind !== 'share_access' || isNewGrant(r, params)))
      .sort((a, b) => String(a.record_code ?? '').localeCompare(String(b.record_code ?? '')) || String(a.record_id).localeCompare(String(b.record_id)));
    if (!cfg || !rows.length) return;
    const recipients = await recipientsOf(action, params, cfg);
    if (!recipients.length) return;
    const logins = [...new Set(recipients.map((r) => r.person.user_id).filter((v) => !isBlank(v)))];
    const users = new Map();
    if (logins.length) for (const u of await database('directus_users').whereIn('id', logins).select('id', 'email')) users.set(String(u.id), u);
    const { name: adder } = await ops.callerName(database, { user: action.actor_user });
    const ids = rows.map((r) => String(r.record_id));
    const held = await heldOn(cfg, params, ids);
    const resolved = schema ?? (typeof context.getSchema === 'function' ? await context.getSchema() : undefined);
    await Promise.all(recipients.map(async ({ person, mode, role, teamName }) => {
      try {
        const to = recipientAddress(person, isBlank(person.user_id) ? null : users.get(String(person.user_id))); // the login's address, else People's
        const mine = rows.filter((r) => !held.has(heldKey(person.person_id, r.record_id)));
        if (!to || !mine.length) {
          tally.skipped += 1;
          return;
        }
        const open = await openableBy(person, cfg, ids);
        const items = mine.map((r) => ({ code: r.record_code ?? '', link: recordLink(env?.PUBLIC_URL, cfg.collection, r.record_id, env?.STARBASE_URL), blocked: !open.has(String(r.record_id)) }));
        const content = summaryContent({ adder, kind: cfg.kind, items, mode, role, teamName, blockedReason: isBlank(person.user_id) ? 'no_login' : 'parent' });
        const mail = new services.MailService({ schema: resolved, knex: database });
        await withTimeout(mail.send({ to, subject: content.subject, html: content.html, text: content.text }), MAIL_TIMEOUT_MS);
        tally.sent += 1;
      } catch (err) {
        tally.failed += 1;
        warn(`the summary mail of bulk action ${action.action_id} to ${person?.person_id} was not sent: ${redacted(err)}`);
      }
    }));
  }

  // Claim the held mail (under the row lock) and send it. Returns { sent, skipped, failed }, or null when there was nothing to send (already sent, undone).
  async function send(actionId, schema) {
    const action = await database.transaction(async (trx) => {
      const a = await trx('bulk_actions').where('action_id', actionId).forUpdate().first();
      if (!a || a.mail_state !== 'pending') return null;
      const gone = a.state === 'undone' || a.state === 'reverted';
      await trx('bulk_actions').where('action_id', actionId).update({ mail_state: gone ? 'cancelled' : 'sent' });
      return gone ? null : a;
    });
    if (!action) return null;
    const tally = { sent: 0, skipped: 0, failed: 0 };
    try {
      await deliver(action, schema, tally);
    } catch (err) {
      warn(`the summary mail of bulk action ${actionId} was not sent: ${redacted(err)}`);
    }
    return tally;
  }

  async function sweep() {
    const now = clock().getTime();
    for (const a of await database('bulk_actions').where('mail_state', 'pending').select('action_id', 'mail_due_at')) {
      const due = a.mail_due_at ? new Date(a.mail_due_at).getTime() : 0;
      if (due <= now) await send(a.action_id, undefined);
      else schedule(a.action_id, new Date(due), undefined);
    }
  }

  return { schedule, cancel, sweep };
}
