// The admin Home "Bulk actions" panel as pure logic (spec docs/superpowers/specs/2026-10-20-bulk-actions-design.md, sections 1 and 4): a journal line in
// plain words (what was done, by whom, when), its counts and state badge, the rows of an expanded line, who may be offered Revert, and the confirm
// dialog's words and the per-row result of a revert. No Vue and no network: bulkApi.ts reads the journal, useAdminBulk.ts holds the state, the
// panel draws it. The words are built from the journal's own fields and never print an id: a team or person the action named is "a team" / "a person"
// (the journal keeps the id only).

import { ago } from '../adminHome';
import { formatDate } from '../format';
import { indexDefByCollection } from '../index/indexConfig';
import type { IndexDef } from '../index/indexConfig';
import { humanise } from '../status';
import type { BulkActionRow, BulkActionSummary } from './bulkApi';
import type { RevertRow } from './bulkModel';
import { lower, recordsText, revertReasonText, skipReasonText, valueText } from './bulkModel';
import { accessResult, roleLabel } from './bulkWords';
import type { AccessRole } from './bulkWords';

/** How many journal lines one page asks for. */
export const PAGE_SIZE = 25;

export type Tone = 'ok' | 'dim' | 'warn' | 'bad';
export interface Tagged {
	label: string;
	tone: Tone;
}

/** The def of a collection, or a stand-in that says "records" for one without an index page (assign to team is accepted on projects). */
const defFor = (collection: string): IndexDef => indexDefByCollection(collection) ?? ({ collection, title: 'records' } as IndexDef);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isRole = (v: unknown): v is AccessRole => v === 'view' || v === 'edit';

// ---- one journal line in words -------------------------------------------------------------------------------------

/** The short name of what the action did, for a chip and for sentences with nothing applied: "Assign to team", "Edit status". */
export function kindLabel(a: Pick<BulkActionSummary, 'kind' | 'collection' | 'params'>): string {
	switch (a.kind) {
		case 'assign_team': return 'Assign to team';
		case 'change_owner': return 'Change owner';
		case 'share_access': return 'Share or change access';
		case 'remove_access': return 'Remove access';
		case 'restrict': return 'Restrict';
		case 'unrestrict': return 'Unrestrict';
		case 'edit_field': {
			const field = str(a.params.field);
			const label = defFor(a.collection).bulkFields?.find((f) => f.field === field)?.label ?? (field ? humanise(field) : 'a field');
			return `Edit ${lower(label)}`;
		}
		default: return humanise(a.kind);
	}
}

const total = (a: BulkActionSummary): number => a.n_applied + a.n_skipped + a.n_failed;

/** What an ordinary action did, in the past tense: "Assigned 38 samples to a team", "Set status to Archived on 38 samples", "Shared 12 operations with a person (Can edit)". */
export function actionWords(a: BulkActionSummary): string {
	const def = defFor(a.collection);
	const n = a.n_applied;
	if (n === 0) return total(a) > 0 ? `${kindLabel(a)} on ${recordsText(def, total(a))}: nothing was changed` : `${kindLabel(a)}: nothing was changed`;
	const what = recordsText(def, n);
	const p = a.params;
	switch (a.kind) {
		case 'assign_team': return accessResult('assign_team', def, n, undefined);
		case 'change_owner': return accessResult('change_owner', def, n, undefined);
		case 'share_access': {
			const base = accessResult('share_access', def, n, p.team_id ? 'a team' : 'a person');
			return isRole(p.role) ? `${base} (${roleLabel(def, p.role)})` : base;
		}
		case 'remove_access': return accessResult('remove_access', def, n, p.team_id ? 'a team' : 'a person');
		case 'restrict': return `Restricted ${what}`;
		case 'unrestrict': return `Unrestricted ${what}`;
		case 'edit_field': {
			const field = str(p.field);
			const bf = def.bulkFields?.find((f) => f.field === field);
			const name = lower(bf?.label ?? (field ? humanise(field) : 'a field'));
			if (p.value === null || p.value === undefined) return `Cleared ${name} on ${what}`;
			// A link's value is an id: the journal has no name for it, and an id is never shown.
			if (!bf || bf.kind === 'relation' || (typeof p.value !== 'string' && typeof p.value !== 'boolean')) return `Set ${name} on ${what}`;
			return `Set ${name} to ${valueText(def, bf, p.value)} on ${what}`;
		}
		default: return `Changed ${what}`;
	}
}

export const isRevert = (a: Pick<BulkActionSummary, 'revert_of'>): boolean => !!a.revert_of;

/** The journal line's headline: the action in words, or for a revert "Revert of ‘Assigned 38 samples to a team’" (its original, when it is among the lines loaded). */
export function headline(a: BulkActionSummary, byId: ReadonlyMap<string, BulkActionSummary> = new Map()): string {
	if (!a.revert_of) return actionWords(a);
	const original = byId.get(a.revert_of);
	return original && !original.revert_of ? `Revert of ‘${actionWords(original)}’` : `Revert of an earlier action on ${lower(defFor(a.collection).title)}`;
}

/** Lines by id, for a revert to find its original. */
export const linesById = (actions: readonly BulkActionSummary[]): Map<string, BulkActionSummary> => new Map(actions.map((a) => [a.action_id, a]));

/** The state badge. A revert is its own kind of line (its state is always applied, so the badge says what it is). */
export function stateBadge(a: Pick<BulkActionSummary, 'state' | 'revert_of'>): Tagged {
	if (a.revert_of) return { label: 'Revert', tone: 'dim' };
	switch (a.state) {
		case 'applied': return { label: 'Applied', tone: 'ok' };
		case 'undone': return { label: 'Undone', tone: 'dim' };
		case 'reverted': return { label: 'Reverted', tone: 'dim' };
		case 'partly_reverted': return { label: 'Partly reverted', tone: 'warn' };
		default: return { label: humanise(a.state || 'unknown'), tone: 'dim' };
	}
}

/** "38 changed, 12 not changed, 1 failed"; a revert's counts are of its own rows: "5 put back, 2 left as they are". Zero parts are left out, except the first. */
export function countsText(a: BulkActionSummary): string {
	const rev = isRevert(a);
	const parts = [
		`${a.n_applied} ${rev ? 'put back' : 'changed'}`,
		a.n_skipped > 0 ? `${a.n_skipped} ${rev ? `left as ${a.n_skipped === 1 ? 'it is' : 'they are'}` : 'not changed'}` : '',
		a.n_failed > 0 ? `${a.n_failed} failed` : '',
	];
	return parts.filter(Boolean).join(', ');
}

/** "2 h ago" (the existing Home helper), '' when the time cannot be read. */
export const whenText = (a: Pick<BulkActionSummary, 'created_at'>, now: number): string => ago(a.created_at, now);

/** The exact moment, for a tooltip: "20 Oct 2026, 10:00". */
export function whenTitle(iso: string): string {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? '' : `${formatDate(iso)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Who ran it: the name, else "Someone" (an action whose person the endpoint could not name). */
export const actorText = (a: Pick<BulkActionSummary, 'actor_name'>): string => a.actor_name.trim() || 'Someone';

/**
 * Is Revert offered? Only on an ordinary action (a revert cannot be reverted: run the action again) that is applied or partly reverted (a retry of
 * what was changed since or refused) and changed something (an action that changed nothing has nothing to put back: the server says 409).
 */
export const canRevert = (a: Pick<BulkActionSummary, 'state' | 'revert_of' | 'n_applied'>): boolean =>
	!a.revert_of && (a.state === 'applied' || a.state === 'partly_reverted') && a.n_applied > 0;

// ---- paging --------------------------------------------------------------------------------------------------------

/** The next page after the lines already shown. Lines are new-first, so a page that arrives late can repeat a line: it is kept once, in its place. */
export function mergePage(shown: readonly BulkActionSummary[], page: readonly BulkActionSummary[]): BulkActionSummary[] {
	const seen = new Set(shown.map((a) => a.action_id));
	return [...shown, ...page.filter((a) => !seen.has(a.action_id) && seen.add(a.action_id))];
}

// ---- the rows of an expanded line -----------------------------------------------------------------------------------

const REVERT_LABELS: Record<string, Tagged> = {
	reverted: { label: 'Reverted', tone: 'ok' },
	changed_since: { label: 'Changed since', tone: 'warn' },
	refused: { label: 'Refused', tone: 'bad' },
	failed: { label: 'Failed', tone: 'bad' },
};

export interface DetailLine {
	key: string;
	code: string;
	result: Tagged;
	/** Why the row was skipped or failed ('' when nothing to say). */
	reason: string;
	/** What a later revert did to the row; null when none has (and for the rows of a revert). */
	revert: (Tagged & { reason: string }) | null;
}

/** The rows of an action, as lines: the record code, what happened, why, and what a revert did to it. */
export function detailLines(a: Pick<BulkActionSummary, 'revert_of'>, rows: readonly BulkActionRow[]): DetailLine[] {
	const rev = isRevert(a);
	return rows.map((r) => {
		const result: Tagged = r.outcome === 'applied' ? { label: rev ? 'Put back' : 'Changed', tone: 'ok' }
			: r.outcome === 'noop' ? { label: 'No change needed', tone: 'dim' }
			: r.outcome === 'skipped' ? { label: rev ? 'Left as it is' : 'Skipped', tone: 'warn' }
			: { label: 'Failed', tone: 'bad' };
		const reason = r.reason ? skipReasonText(r.reason) : '';
		const kind = !rev && r.revert_outcome ? REVERT_LABELS[r.revert_outcome] : null;
		return {
			key: r.record_id, code: r.record_code, result, reason,
			revert: kind ? { ...kind, reason: r.revert_outcome === 'reverted' ? '' : revertReasonText({ id: r.record_id, revert_outcome: r.revert_outcome!, reason: r.revert_reason }) } : null,
		};
	});
}

// ---- the revert dialog ----------------------------------------------------------------------------------------------

export interface RevertConfirm {
	title: string;
	/** What will happen, in order; the last two are the cautions. */
	paragraphs: string[];
	/** "Revert 38 samples" */
	confirm: string;
}

/** What the confirm dialog says: what will be put back, that records changed since are left alone, and that a revert cannot be reverted. */
export function revertConfirm(a: BulkActionSummary, byId: ReadonlyMap<string, BulkActionSummary> = new Map()): RevertConfirm {
	const def = defFor(a.collection);
	const when = whenTitle(a.created_at);
	const first = `${headline(a, byId)}, by ${actorText(a)}${when ? ` on ${when}` : ''}.`;
	const what = recordsText(def, a.n_applied);
	return {
		title: 'Revert this bulk action?',
		paragraphs: [
			first,
			a.state === 'partly_reverted'
				? 'Reverting tries again for the records not yet put back; the ones already put back stay as they are.'
				: `Reverting puts ${what} back as they were before.`,
			'A record changed since this action ran is skipped and left as it is. A record the rules no longer let you put back is refused, with its reason.',
			'A revert cannot be reverted. To change the records again, run the action again.',
		],
		// A partly reverted action has rows already put back and the panel does not know how many remain: no count then.
		confirm: a.state === 'partly_reverted' ? 'Revert the rest' : `Revert ${what}`,
	};
}

export interface RevertLine {
	key: string;
	code: string;
	result: Tagged;
	reason: string;
}

const RANK: Record<string, number> = { failed: 0, refused: 1, changed_since: 2, reverted: 3 };

/** The per-row result of a revert: records that were not put back first (failed, refused, changed since), then those put back. */
export function revertLines(results: readonly RevertRow[]): RevertLine[] {
	return results
		.map((r, i) => ({ r, i }))
		.sort((x, y) => RANK[x.r.revert_outcome] - RANK[y.r.revert_outcome] || x.i - y.i)
		.map(({ r }) => ({
			key: r.id, code: r.code ?? r.id, result: REVERT_LABELS[r.revert_outcome],
			reason: r.revert_outcome === 'reverted' ? '' : revertReasonText(r),
		}));
}

/** "Put back 5 of 8 records. 2 changed since, 1 refused." (nothing put back reads "Nothing was put back"). */
export function revertSummary(results: readonly RevertRow[], collection: string): string {
	const n = (o: string): number => results.filter((r) => r.revert_outcome === o).length;
	const reverted = n('reverted');
	const first = reverted > 0 ? `Put back ${reverted} of ${recordsText(defFor(collection), results.length)}` : 'Nothing was put back';
	const rest = [
		n('changed_since') > 0 ? `${n('changed_since')} changed since` : '',
		n('refused') > 0 ? `${n('refused')} refused` : '',
		n('failed') > 0 ? `${n('failed')} failed` : '',
	].filter(Boolean);
	return `${first}.${rest.length ? ` ${rest.join(', ')}.` : ''}`;
}

// ---- failures: what failed and what to do next ---------------------------------------------------------------------

const sentence = (message: string): string => {
	const text = message.trim();
	return /[.!?]$/.test(text) ? text : `${text}.`;
};

/** The list could not be read. */
export const listFailedText = (message: string): string => `The bulk actions could not be loaded: ${sentence(message)} Try Reload in a moment.`;
/** The next page could not be read; the lines already shown stand. */
export const moreFailedText = (message: string): string => `The next bulk actions could not be loaded: ${sentence(message)} Press Show more to try again.`;
/** The rows of one action could not be read. */
export const rowsFailedText = (message: string): string => `The records of this action could not be loaded: ${sentence(message)} Close it and open it again.`;
/** A revert that could not be made: the list is read again, so look there first. */
export const revertFailedText = (message: string): string => `The revert failed: ${sentence(message)} The list has been reloaded; check it before you try again.`;
