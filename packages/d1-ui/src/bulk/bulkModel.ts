// Bulk actions on an index page, as pure logic (spec docs/superpowers/specs/2026-10-20-bulk-actions-design.md, section 4):
// which entries the "With N selected" menu offers a list, the words of the dialog and the toast, the skip reasons,
// the undo countdown and the toast's small state machine. No Vue and no network; bulkApi.ts talks to the endpoint,
// useBulkActions.ts holds the state, the components draw it.

import { choiceKindFor, choiceLabel } from '../choiceLabels';
import { formatDate } from '../format';
import type { BulkField, IndexDef } from '../index/indexConfig';
import { nounsFor } from '../index/pickMode';
import { humanise, statusStyle } from '../status';

// ---- the endpoint's words ------------------------------------------------------------------------------------------

/** What the endpoint can do (spec 3.2). This change offers restrict, unrestrict and edit_field; the rest arrive with their own dialogs. */
export type BulkKind = 'assign_team' | 'change_owner' | 'share_access' | 'remove_access' | 'restrict' | 'unrestrict' | 'edit_field';

export type PreviewStatus = 'ok' | 'noop' | 'skip';
export interface PreviewRow {
	id: string;
	code: string;
	status: PreviewStatus;
	reason?: string;
	/** A consequence the person should read before applying (ownership transfers). */
	warning?: string;
}

export type ApplyOutcome = 'applied' | 'noop' | 'skipped' | 'failed';
export interface ApplyRow {
	id: string;
	code: string;
	outcome: ApplyOutcome;
	reason?: string;
}

export type RevertOutcome = 'reverted' | 'changed_since' | 'refused' | 'failed';
export interface RevertRow {
	id: string;
	revert_outcome: RevertOutcome;
	reason?: string;
}

// ---- the menu ------------------------------------------------------------------------------------------------------

/** One entry of the "With N selected" menu. `print` is the page's own select action (labels), not a bulk kind. */
export interface BulkEntry {
	id: string;
	kind: 'print' | BulkKind;
	label: string;
	/** An edit_field entry carries its field. */
	field?: BulkField;
}

const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The entries a list offers, in menu order: Print labels (the def's select action), Restrict and Unrestrict (the four ownable
 * record types), then one "Edit <field>…" per bulk field. A Lab Viewer changes nothing (the server refuses even a preview), so a
 * viewer is offered only the entries that navigate. A list with no entries gets no menu.
 */
export function bulkEntries(def: IndexDef, opts: { viewer?: boolean } = {}): BulkEntry[] {
	const out: BulkEntry[] = [];
	if (def.selectAction) out.push({ id: 'print', kind: 'print', label: 'Print labels' });
	if (opts.viewer) return out;
	if (def.ownable) {
		out.push({ id: 'restrict', kind: 'restrict', label: 'Restrict…' });
		out.push({ id: 'unrestrict', kind: 'unrestrict', label: 'Unrestrict…' });
	}
	for (const field of def.bulkFields ?? []) out.push({ id: `field:${field.field}`, kind: 'edit_field', label: `Edit ${lower(field.label)}…`, field });
	return out;
}

/** The menu button: "With selected" with nothing ticked, "With 4 selected" otherwise. */
export const menuLabel = (count: number): string => (count > 0 ? `With ${count} selected` : 'With selected');

// ---- the dialog ----------------------------------------------------------------------------------------------------

/** "38 samples", "1 sample", "4 records" (a def's own title, singular or plural). */
export function recordsText(def: IndexDef, count: number): string {
	const nouns = nounsFor(def.title);
	return `${count} ${count === 1 ? nouns.one : nouns.many}`;
}

/** "Edit status for 38 samples", "Restrict 5 operations". */
export function dialogTitle(entry: BulkEntry, def: IndexDef, count: number): string {
	const what = recordsText(def, count);
	if (entry.kind === 'edit_field' && entry.field) return `Edit ${lower(entry.field.label)} for ${what}`;
	if (entry.kind === 'unrestrict') return `Unrestrict ${what}`;
	return `Restrict ${what}`;
}

/** What the person chose in the target step: a field value (null clears it). `null` for no choice yet. */
export type BulkChoice = { value: string | boolean | null } | null;

/** The request's `params`, or null while the dialog still waits for a choice (no preview is asked for yet). */
export function paramsFor(entry: BulkEntry, choice: BulkChoice): Record<string, unknown> | null {
	if (entry.kind === 'edit_field') return entry.field && choice ? { field: entry.field.field, value: choice.value } : null;
	if (entry.kind === 'restrict' || entry.kind === 'unrestrict') return {};
	return null;
}

/** Can the target step offer "Clear value"? Not on a column the database does not let be empty (status, a yes / no flag). */
export const canClear = (field: BulkField): boolean => field.kind === 'relation' || field.kind === 'date';

/** The words for one stored value of a bulk field. `relationLabel` is the picked related row's display text. */
export function valueText(def: IndexDef, field: BulkField, value: string | boolean | null, relationLabel?: string): string {
	if (value === null) return 'empty';
	if (field.kind === 'bool') return value === true || value === 'true' ? 'Yes' : 'No';
	if (field.kind === 'date') return formatDate(String(value));
	if (field.kind === 'relation') return relationLabel ?? String(value);
	if (def.collection === 'physical_samples' && field.field === 'current_status') return statusStyle('sample', String(value))?.label ?? humanise(String(value));
	const choice = choiceKindFor(def.collection, field.field);
	return choice ? choiceLabel(choice, value) : humanise(String(value));
}

/** The enum choices of a field, labelled. */
export const enumChoices = (def: IndexDef, field: BulkField): { value: string; label: string }[] =>
	(field.values ?? []).map((value) => ({ value, label: valueText(def, field, value) }));

// ---- the dry run ---------------------------------------------------------------------------------------------------

export interface PreviewCounts {
	ok: number;
	noop: number;
	skip: number;
}
export function previewCounts(rows: readonly PreviewRow[]): PreviewCounts {
	const counts = { ok: 0, noop: 0, skip: 0 };
	for (const r of rows) counts[r.status] += 1;
	return counts;
}

/** "38 can be changed. 12 will be skipped" (a run of "no change" rows is said too). */
export function previewSummary(counts: PreviewCounts): string {
	const parts = [counts.ok > 0 ? `${counts.ok} can be changed` : 'None can be changed'];
	if (counts.noop > 0) parts.push(`${counts.noop} need no change`);
	if (counts.skip > 0) parts.push(`${counts.skip} will be skipped`);
	return parts.join('. ');
}

/** The Apply button: "Apply to 38". Disabled at 0 (see canApply). */
export const applyLabel = (ok: number): string => `Apply to ${ok}`;
export const canApply = (counts: PreviewCounts): boolean => counts.ok > 0;

/** The distinct warnings of the rows that would change, in the order met. */
export function previewWarnings(rows: readonly PreviewRow[]): string[] {
	const seen: string[] = [];
	for (const r of rows) if (r.status === 'ok' && r.warning && !seen.includes(r.warning)) seen.push(r.warning);
	return seen;
}

// ---- skip reasons --------------------------------------------------------------------------------------------------

// The endpoint writes its reasons in plain words; a bare code (or nothing) still reads as a sentence.
const REASONS: Record<string, string> = {
	NOT_FOUND: 'Not found or not visible to you',
	FORBIDDEN: 'You do not have permission to change this',
	RESTRICT_ADMIN_ONLY: 'Only administrators can restrict records yet',
	READ_ONLY_ROLE: 'Your account can look but not change',
	NOT_OWNER: 'You are not the owner',
};

/** A reason as a short sentence without its full stop ("You are not the owner"). */
export function skipReasonText(reason: string | null | undefined): string {
	const text = (reason ?? '').trim().replace(/\.+$/, '');
	if (!text) return 'Could not be changed';
	if (REASONS[text]) return REASONS[text];
	return /^[A-Z0-9_]+$/.test(text) ? humanise(text.toLowerCase()) : text.charAt(0).toUpperCase() + text.slice(1);
}

export interface SkippedRow {
	id: string;
	code: string;
	reason: string;
}
export interface SkipGroup {
	reason: string;
	rows: { id: string; code: string }[];
}

/** Rows of one reason together, the biggest group first (equal groups keep the order met). */
export function groupSkips(rows: readonly SkippedRow[]): SkipGroup[] {
	const groups: SkipGroup[] = [];
	for (const r of rows) {
		const text = skipReasonText(r.reason);
		const group = groups.find((g) => g.reason === text);
		if (group) group.rows.push({ id: r.id, code: r.code });
		else groups.push({ reason: text, rows: [{ id: r.id, code: r.code }] });
	}
	return groups.map((g, i) => ({ g, i })).sort((a, b) => b.g.rows.length - a.g.rows.length || a.i - b.i).map((x) => x.g);
}

/** The skipped preview rows, ready for groupSkips. */
export const previewSkips = (rows: readonly PreviewRow[]): SkippedRow[] =>
	rows.filter((r) => r.status === 'skip').map((r) => ({ id: r.id, code: r.code, reason: r.reason ?? '' }));

/** The rows an apply did not change because they were skipped or failed (a no-op row needs nothing). */
export const applySkips = (rows: readonly ApplyRow[]): SkippedRow[] =>
	rows.filter((r) => r.outcome === 'skipped' || r.outcome === 'failed').map((r) => ({ id: r.id, code: r.code, reason: r.reason ?? '' }));

/** "Changed since" and the other reasons a row was left alone by an undo. */
export function revertReasonText(row: RevertRow): string {
	if (row.revert_outcome === 'changed_since') return 'Changed since, so it was left as it is';
	if (row.reason) return skipReasonText(row.reason);
	return row.revert_outcome === 'refused' ? 'Could not be put back' : 'Could not be undone';
}

// ---- the toast's words ---------------------------------------------------------------------------------------------

/** "Set status to Archived on 38 samples", "Restricted 5 operations", "Cleared project on 2 samples". */
export function resultText(entry: BulkEntry, def: IndexDef, applied: number, choice: BulkChoice, relationLabel?: string): string {
	const what = recordsText(def, applied);
	if (applied === 0) return 'Nothing was changed';
	if (entry.kind === 'unrestrict') return `Unrestricted ${what}`;
	if (entry.kind === 'restrict') return `Restricted ${what}`;
	if (entry.kind === 'edit_field' && entry.field && choice) {
		const name = lower(entry.field.label);
		return choice.value === null ? `Cleared ${name} on ${what}` : `Set ${name} to ${valueText(def, entry.field, choice.value, relationLabel)} on ${what}`;
	}
	return `Changed ${what}`;
}

// ---- the undo countdown --------------------------------------------------------------------------------------------

/** The undo window in seconds (spec decision 11). */
export const BULK_UNDO_SECONDS = 60;

/** Whole seconds left until `undoUntil` (ISO text, ms or Date), 0 to 60: a clock that is behind the server's never shows more than the window. */
export function secondsLeft(undoUntil: string | number | Date, now: number): number {
	const until = undoUntil instanceof Date ? undoUntil.getTime() : typeof undoUntil === 'number' ? undoUntil : Date.parse(undoUntil);
	if (!Number.isFinite(until)) return 0;
	return Math.min(BULK_UNDO_SECONDS, Math.max(0, Math.ceil((until - now) / 1000)));
}

/**
 * When the toast's countdown ends, in this browser's clock: the server's `undo_until` while the two clocks agree to within five
 * seconds, else a full window from the moment the answer arrived (the server still decides whether an undo is in time).
 */
export function deadlineFor(undoUntil: string, receivedAt: number): number {
	const until = Date.parse(undoUntil);
	const window = BULK_UNDO_SECONDS * 1000;
	return Number.isFinite(until) && Math.abs(until - receivedAt - window) <= 5000 ? until : receivedAt + window;
}

/** How much of the ring is left, 0 to 1. */
export const ringFraction = (left: number): number => Math.min(1, Math.max(0, left / BULK_UNDO_SECONDS));

// ---- the toast's state machine: pending -> done | undone -----------------------------------------------------------

export type ToastPhase = 'pending' | 'done' | 'undone';

export interface ToastModel {
	actionId: string;
	/** "Set status to Archived on 38 samples" */
	message: string;
	/** ms since the epoch in this browser's clock. */
	deadline: number;
	phase: ToastPhase;
	left: number;
	/** An undo is in flight. */
	busy: boolean;
	/** An undo that failed (the window passed, the network): said, and the toast stays until it ends. */
	error: string;
	/** Rows the action skipped, and the rows an undo left alone. */
	skipped: SkippedRow[];
	undoSkipped: SkippedRow[];
}

export function startToast(actionId: string, message: string, deadline: number, skipped: SkippedRow[], now: number): ToastModel {
	const left = secondsLeft(deadline, now);
	return { actionId, message, deadline, phase: left > 0 ? 'pending' : 'done', left, busy: false, error: '', skipped, undoSkipped: [] };
}

/** One tick of the clock: the seconds left, and `done` when they run out (an undo in flight is allowed to finish). */
export function tickToast(t: ToastModel, now: number): ToastModel {
	if (t.phase !== 'pending') return t;
	const left = secondsLeft(t.deadline, now);
	if (left === t.left) return t;
	return { ...t, left, phase: left > 0 || t.busy ? 'pending' : 'done' };
}

export const beginUndo = (t: ToastModel): ToastModel => (t.phase === 'pending' && !t.busy ? { ...t, busy: true, error: '' } : t);

export function undoFailed(t: ToastModel, message: string, now: number): ToastModel {
	const left = secondsLeft(t.deadline, now);
	return { ...t, busy: false, error: message, left, phase: left > 0 ? 'pending' : 'done' };
}

export function undoDone(t: ToastModel, results: readonly RevertRow[], codes: ReadonlyMap<string, string>): ToastModel {
	const undoSkipped = results
		.filter((r) => r.revert_outcome !== 'reverted')
		.map((r) => ({ id: r.id, code: codes.get(r.id) ?? r.id, reason: revertReasonText(r) }));
	return { ...t, phase: 'undone', busy: false, error: '', undoSkipped };
}

/** The rows an undo did not put back: they stay ticked, like the rows an apply skipped. */
export const notRevertedIds = (results: readonly RevertRow[]): string[] => results.filter((r) => r.revert_outcome !== 'reverted').map((r) => r.id);

/** What the toast's status region says, only when something changes: the result, then "Done" or "Undone". The ticking number is not part of it. */
export function toastAnnouncement(t: ToastModel): string {
	if (t.phase === 'done') return 'Done';
	if (t.phase === 'undone') return t.undoSkipped.length ? `Undone. ${t.undoSkipped.length} left as they are` : 'Undone';
	return t.skipped.length ? `${t.message}. ${t.skipped.length} skipped` : t.message;
}

/** Milliseconds until a finished toast goes by itself; null when it stays (something to read: skipped rows, or an undo's leftovers). */
export function dismissDelay(t: ToastModel): number | null {
	if (t.phase === 'pending') return null;
	if (t.skipped.length || t.undoSkipped.length) return null;
	return t.phase === 'done' ? 3000 : 5000;
}
