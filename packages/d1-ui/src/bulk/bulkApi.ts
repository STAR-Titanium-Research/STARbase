// The calls of bulk actions: the d1-bulk-actions endpoint (core/extensions/d1-bulk-actions, spec 3.2) and the option list of a
// relation field. Like accessApi, every call returns plain data or the endpoint's own message; nothing throws, so the dialog
// shows the text it is given. The endpoint answers with the bare JSON (no `data` wrapper).
import type { AccessApi, Outcome } from '../access/accessApi';
import { errorText } from '../format';
import type { BulkField } from '../index/indexConfig';
import { relationKey, relationOptionParams, relationOptions } from '../index/indexView';
import type { ChipOption } from '../index/indexView';
import type { ApplyOutcome, ApplyRow, BulkKind, PreviewRow, PreviewStatus, RevertOutcome, RevertRow } from './bulkModel';

export type { Outcome };

const BASE = '/d1-bulk-actions';
const collectionBase = (collection: string): string => `${BASE}/${encodeURIComponent(collection)}`;
const actionBase = (actionId: string): string => `${BASE}/${encodeURIComponent(actionId)}`;

async function run<T>(work: () => Promise<T>): Promise<Outcome<T>> {
	try {
		return { ok: true, data: await work() };
	} catch (e) {
		return { ok: false, message: errorText(e, 'Could not reach the server.') };
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const optional = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const STATUSES: readonly PreviewStatus[] = ['ok', 'noop', 'skip'];
const OUTCOMES: readonly ApplyOutcome[] = ['applied', 'noop', 'skipped', 'failed'];
const REVERTS: readonly RevertOutcome[] = ['reverted', 'changed_since', 'refused', 'failed'];

// A row the endpoint did not make sense of counts as skipped / failed, never as changed.
const previewRow = (r: Record<string, unknown>): PreviewRow => ({
	id: text(r.id), code: text(r.code) || text(r.id), status: oneOf(r.status, STATUSES, 'skip'), reason: optional(r.reason), warning: optional(r.warning),
});
const applyRow = (r: Record<string, unknown>): ApplyRow => ({
	id: text(r.id), code: text(r.code) || text(r.id), outcome: oneOf(r.outcome, OUTCOMES, 'failed'), reason: optional(r.reason),
});
const revertRow = (r: Record<string, unknown>): RevertRow => ({
	id: text(r.id), ...(optional(r.code) ? { code: optional(r.code) } : {}), revert_outcome: oneOf(r.revert_outcome, REVERTS, 'failed'), reason: optional(r.reason),
});

/** The dry run: what apply would do to each row, without writing. (The counts are worked out from the rows.) */
export const previewBulk = (api: AccessApi, collection: string, kind: BulkKind, ids: string[], params: Record<string, unknown>): Promise<Outcome<PreviewRow[]>> =>
	run(async () => list(((await api.post(`${collectionBase(collection)}/preview`, { kind, ids, params })).data ?? {}).results).map(previewRow));

export interface ApplyAnswer {
	actionId: string;
	/** ISO time the undo window closes. */
	undoUntil: string;
	results: ApplyRow[];
}

/** Applies the action; each row commits on its own, so some may be skipped. */
export const applyBulk = (api: AccessApi, collection: string, kind: BulkKind, ids: string[], params: Record<string, unknown>): Promise<Outcome<ApplyAnswer>> =>
	run(async () => {
		const body = (await api.post(`${collectionBase(collection)}/apply`, { kind, ids, params })).data ?? {};
		return { actionId: text(body.action_id), undoUntil: text(body.undo_until), results: list(body.results).map(applyRow) };
	});

export interface RevertAnswer {
	state: string;
	/** The journal line the revert itself was written as. */
	revertActionId?: string;
	results: RevertRow[];
}
const revertAnswer = (body: Record<string, unknown>): RevertAnswer => ({
	state: text(body.state), ...(optional(body.revert_action_id) ? { revertActionId: optional(body.revert_action_id) } : {}), results: list(body.results).map(revertRow),
});

/** Takes an action back (its actor inside the 60-second window, or an administrator). A row changed since is left as it is. */
export const undoBulk = (api: AccessApi, actionId: string): Promise<Outcome<RevertAnswer>> =>
	run(async () => revertAnswer((await api.post(`${actionBase(actionId)}/undo`)).data ?? {}));

/** An administrator takes an action back at any time. */
export const revertBulk = (api: AccessApi, actionId: string): Promise<Outcome<RevertAnswer>> =>
	run(async () => revertAnswer((await api.post(`${actionBase(actionId)}/revert`)).data ?? {}));

/** A journal line, as the list and the detail answer it. Unknown extra fields are left out. */
export interface BulkActionSummary {
	action_id: string;
	actor_user: string;
	/** The actor's name ('' when the endpoint has none). */
	actor_name: string;
	collection: string;
	kind: string;
	/** The request's params: { team_id } | { person_id } | { person_id | team_id, role } | { field, value } | {}. */
	params: Record<string, unknown>;
	state: string;
	created_at: string;
	/** ISO time the 60-second undo window closed. */
	undo_until: string;
	/** The action this one reverts; null for an ordinary action. */
	revert_of: string | null;
	mail_state: string;
	n_applied: number;
	n_skipped: number;
	n_failed: number;
}

const summary = (a: Record<string, unknown>): BulkActionSummary => ({
	action_id: text(a.action_id), actor_user: text(a.actor_user), actor_name: text(a.actor_name), collection: text(a.collection), kind: text(a.kind),
	params: isRecord(a.params) ? a.params : {}, state: text(a.state), created_at: text(a.created_at), undo_until: text(a.undo_until),
	revert_of: optional(a.revert_of) ?? null, mail_state: text(a.mail_state), n_applied: count(a.n_applied), n_skipped: count(a.n_skipped), n_failed: count(a.n_failed),
});

export interface BulkListPage {
	actions: BulkActionSummary[];
	/** More lines follow this page. */
	hasMore: boolean;
}

/** The journal: everything for an administrator, the caller's own otherwise; newest first, a page at a time. */
export const listBulk = (api: AccessApi, opts: { limit?: number; offset?: number } = {}): Promise<Outcome<BulkListPage>> =>
	run(async () => {
		const params: Record<string, unknown> = {};
		if (opts.limit) params.limit = opts.limit;
		if (opts.offset) params.offset = opts.offset;
		const body = (await api.get(BASE, { params })).data ?? {};
		return { actions: list(body.actions).map(summary), hasMore: body.has_more === true };
	});

/** One journal row of an action: what happened to a record, and what a later revert did to it. (The before and after snapshots are not carried.) */
export interface BulkActionRow {
	record_id: string;
	record_code: string;
	outcome: ApplyOutcome;
	reason?: string;
	/** Set once a revert (or undo) has dealt with the row; null before. */
	revert_outcome: RevertOutcome | null;
	revert_reason?: string;
}

const actionRow = (r: Record<string, unknown>): BulkActionRow => ({
	record_id: text(r.record_id), record_code: text(r.record_code) || text(r.record_id), outcome: oneOf(r.outcome, OUTCOMES, 'failed'), reason: optional(r.reason),
	revert_outcome: REVERTS.includes(r.revert_outcome as RevertOutcome) ? (r.revert_outcome as RevertOutcome) : null, revert_reason: optional(r.revert_reason),
});

export interface BulkDetail {
	action: BulkActionSummary;
	rows: BulkActionRow[];
}

/** One action with its rows (an administrator sees any; anyone else only their own). */
export const getBulk = (api: AccessApi, actionId: string): Promise<Outcome<BulkDetail>> =>
	run(async () => {
		const body = (await api.get(actionBase(actionId))).data ?? {};
		return { action: summary(isRecord(body.action) ? body.action : {}), rows: list(body.rows).map(actionRow) };
	});

/** The rows a link field can point at, read as the signed-in user like a relation filter chip (the first 200 by display). */
export const loadFieldOptions = (api: AccessApi, field: BulkField): Promise<Outcome<ChipOption[]>> =>
	run(async () => {
		const rel = field.relation;
		const key = rel ? relationKey(rel.collection) : null;
		if (!rel || !key) throw new Error('This field has no list to choose from.');
		const res = await api.get(`/items/${rel.collection}`, { params: relationOptionParams(key, rel.display, rel.fallback) });
		return relationOptions(res.data?.data, key, rel.display, rel.fallback);
	});
