// The words and params of the ownership and access bulk actions (assign to a team, change owner, share or change access, remove
// access), and the warning rows of a preview. A leaf of bulkModel.ts (which re-exports what its callers use): no Vue, no network.

import { ROLE_LABELS } from '../access/accessModel';
import type { IndexDef } from '../index/indexConfig';
import { nounsFor } from '../index/pickMode';
import type { BulkChoice, BulkEntry, PreviewRow, SkippedRow } from './bulkModel';

export const lower = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** "38 samples", "1 sample", "4 records" (a def's own title, singular or plural). */
export function recordsText(def: IndexDef, count: number): string {
	const nouns = nounsFor(def.title);
	return `${count} ${count === 1 ? nouns.one : nouns.many}`;
}

// ---- which kinds, which target --------------------------------------------------------------------------------------

/** The four kinds that change who owns or sees a record: they offer a person or a team to act on. */
export const ACCESS_KINDS = ['assign_team', 'change_owner', 'share_access', 'remove_access'] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];
export const isAccessKind = (kind: string): kind is AccessKind => (ACCESS_KINDS as readonly string[]).includes(kind);

/** What the target step asks for: a team, a person, or either (share and remove take both). */
export type TargetKind = 'team' | 'person' | 'either';
export function targetKindOf(kind: string): TargetKind | null {
	if (kind === 'assign_team') return 'team';
	if (kind === 'change_owner') return 'person';
	return kind === 'share_access' || kind === 'remove_access' ? 'either' : null;
}

export type AccessRole = 'view' | 'edit';
export const DEFAULT_ROLE: AccessRole = 'view';
/** Does the target step show the access level? */
export const takesRole = (kind: string): boolean => kind === 'share_access';

/** "Can view" / "Can edit", as the Who has access dialog words them for this record type. */
export const roleLabel = (def: IndexDef, role: AccessRole): string => ROLE_LABELS(def.collection).find((r) => r.role === role)?.label ?? role;
export const roleChoices = (def: IndexDef): { value: AccessRole; label: string }[] =>
	ROLE_LABELS(def.collection)
		.filter((r): r is typeof r & { role: AccessRole } => r.role === 'view' || r.role === 'edit')
		.map((r) => ({ value: r.role, label: r.label }));

/** The request params of an access kind, or null while no target is chosen. A team goes as `team_id`, a person as `person_id`. */
export function accessParams(kind: AccessKind, choice: BulkChoice, role: AccessRole): Record<string, unknown> | null {
	if (!choice || typeof choice.value !== 'string' || !choice.value) return null;
	if (kind === 'assign_team') return { team_id: choice.value };
	if (kind === 'change_owner') return { person_id: choice.value };
	const target = choice.target === 'team' ? { team_id: choice.value } : { person_id: choice.value };
	return kind === 'share_access' ? { ...target, role } : target;
}

// ---- the sentences --------------------------------------------------------------------------------------------------

/** The dialog's heading: what is done to what, before a target is chosen ("Assign 38 samples to a team"). */
export function accessTitle(kind: AccessKind, def: IndexDef, count: number): string {
	const what = recordsText(def, count);
	if (kind === 'assign_team') return `Assign ${what} to a team`;
	if (kind === 'change_owner') return `Change the owner of ${what}`;
	if (kind === 'share_access') return `Share or change access to ${what}`;
	return `Remove access to ${what}`;
}

/** The sentence the preview confirms once a target is chosen: "Share 12 operations with Ann (Can edit)". */
export function accessSentence(kind: AccessKind, def: IndexDef, count: number, name: string, role: AccessRole): string {
	const what = recordsText(def, count);
	if (kind === 'assign_team') return `Assign ${what} to ${name}`;
	if (kind === 'change_owner') return `Change the owner of ${what} to ${name}`;
	if (kind === 'share_access') return `Share ${what} with ${name} (${roleLabel(def, role)})`;
	return `Remove ${name}'s access to ${what}`;
}

/** The toast's result: "Assigned 38 samples to Team X", "Shared 12 operations with Ann", "Removed access for Ann on 12 operations". */
export function accessResult(kind: AccessKind, def: IndexDef, applied: number, name: string | undefined): string {
	const what = recordsText(def, applied);
	if (kind === 'assign_team') return name ? `Assigned ${what} to ${name}` : `Assigned ${what} to a team`;
	if (kind === 'change_owner') return name ? `Changed the owner of ${what} to ${name}` : `Changed the owner of ${what}`;
	if (kind === 'share_access') return name ? `Shared ${what} with ${name}` : `Shared ${what}`;
	return name ? `Removed access for ${name} on ${what}` : `Removed access on ${what}`;
}

/** The menu's entries for an ownable list, in menu order. */
export function accessEntries(): BulkEntry[] {
	return [
		{ id: 'assign_team', kind: 'assign_team', label: 'Assign to team…' },
		{ id: 'change_owner', kind: 'change_owner', label: 'Change owner…' },
		{ id: 'share_access', kind: 'share_access', label: 'Share or change access…' },
		{ id: 'remove_access', kind: 'remove_access', label: 'Remove access…' },
	];
}

/** What the target step says before anything is chosen. */
export function targetHint(kind: AccessKind): string {
	if (kind === 'assign_team') return 'Choose a team to see what would change.';
	if (kind === 'change_owner') return 'Search for a person to see what would change.';
	return 'Search for a person or a team to see what would change.';
}

// ---- warnings: consequences to read before applying ----------------------------------------------------------------

/** The rows that would change and carry a warning (the acting manager may lose access, say), each with its warning as the reason. */
export const warnedRows = (rows: readonly PreviewRow[]): SkippedRow[] =>
	rows.filter((r) => r.status === 'ok' && r.warning).map((r) => ({ id: r.id, code: r.code, reason: r.warning ?? '' }));

/** "1 has a warning", "3 have a warning": the visible count above the Apply button. */
export const warnedSummary = (n: number): string => (n === 1 ? '1 has a warning' : `${n} have a warning`);

/** The line that folds the warned rows in the dialog. */
export const warnedQuestion = (n: number): string => (n === 1 ? 'Which one has a warning?' : `Which ${n} have a warning?`);

/** The toast's line that folds the warned rows that were applied: "1 had a warning", "3 had a warning". */
export const warnedAfter = (n: number): string => (n === 1 ? '1 had a warning' : `${n} had a warning`);

// ---- bare reason codes of the new kinds ------------------------------------------------------------------------------

// The endpoint writes its reasons in plain words; these are the codes of d1-record-access and d1-access-guard that can still arrive bare.
export const REASON_WORDS: Record<string, string> = {
	TEAM_HAS_NO_MANAGER: 'That team has no manager yet',
	NOT_OWNABLE_BY_TEAM: 'This kind of record cannot be owned by a team',
	TEAM_OWNS_RECORD: 'That team owns this record, so it already has access',
};
