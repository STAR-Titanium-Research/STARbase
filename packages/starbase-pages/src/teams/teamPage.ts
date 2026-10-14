// The words and rules of the Teams view, a team's page and the Home "Waiting for you" card, as pure functions (no Vue, no network), so
// they are unit-tested. Wording follows CONTEXT.md: team, team manager, pending member (a person waiting on a record's owner).
import { DEFAULT_TEAM_COLOR, isTeamColor } from '@d1/ui';
import type { PendingItem, TeamColor, TeamEvent, TeamLevel, TeamSummary } from '@d1/ui';

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;
/** The endpoint refuses a logo above this (1 MB); the dialog says so before uploading. */
export const LOGO_MAX_BYTES = 1048576;

export const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** "6 members · 6 records": the records are every grant of the team (counts are over all of them, readable or not). */
export const membersAndRecords = (members: number, counts: Record<TeamLevel, number>): string =>
	`${plural(members, 'member')} · ${plural(counts.view + counts.edit + counts.investigator, 'record')}`;

const LEVELS: { key: TeamLevel; label: string }[] = [
	{ key: 'edit', label: 'Can edit' },
	{ key: 'view', label: 'Can view' },
	{ key: 'investigator', label: 'Investigator' },
];
/** The count of records per access level, in the order a team page shows them. ("Owns" joins once teams can own records.) */
export const levelCounts = (counts: Record<TeamLevel, number>): { key: TeamLevel; label: string; n: number }[] =>
	LEVELS.map((l) => ({ ...l, n: counts[l.key] ?? 0 }));

/** "and 26 you can't see", under the list of records the viewer may read; null when there are none hidden. */
export const hiddenLine = (n: number): string | null => (n > 0 ? `and ${n} you can't see` : null);

export const managersLine = (managers: { full_name: string | null }[]): string => managers.map((m) => m.full_name || 'Unnamed').join(', ');

/** Who may edit, delete and manage the members of a team: its managers and administrators. */
export const canManage = (team: Pick<TeamSummary, 'is_manager'> | null, isAdmin: boolean): boolean => !!team && (team.is_manager || isAdmin);

export const teamsShown = (teams: TeamSummary[], chip: 'all' | 'mine'): TeamSummary[] => (chip === 'mine' ? teams.filter((t) => t.is_member) : teams);

/** The props TeamTile takes; an unknown colour key (an older row) is the default teal. */
export const tileOf = (t: { name: string; color: string; logo?: string | null }): { name: string; color: TeamColor; logo?: string | null } => ({
	name: t.name,
	color: isTeamColor(t.color) ? t.color : DEFAULT_TEAM_COLOR,
	logo: t.logo,
});

// ---- history ----

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const LEVEL_NAMES: Record<string, string> = { view: 'Can view', edit: 'Can edit', investigator: 'Investigator' };

function recordText(e: TeamEvent): string {
	if (e.record_hidden) return "a record you can't see";
	if (!e.record_kind && !e.record_code) return 'a record';
	return [e.record_kind ? capital(e.record_kind) : null, e.record_code].filter(Boolean).join(' ');
}

/** One line of a team's history, e.g. "Alex Hart added Femi Noor as a manager". */
export function historyLabel(e: TeamEvent): string {
	const who = e.actor_name || 'Someone';
	const person = e.person_name || 'someone';
	const d = obj(e.detail);
	switch (e.kind) {
		case 'created':
			return `${who} created the team`;
		case 'renamed': {
			const from = str(d.from);
			const to = str(d.to);
			return from && to ? `${who} renamed the team from ${from} to ${to}` : `${who} renamed the team`;
		}
		case 'member_added':
			return `${who} added ${person}${d.is_manager === true ? ' as a manager' : ''}`;
		case 'member_removed':
			return e.actor_person_id && e.actor_person_id === e.person_id ? `${person} left the team` : `${who} removed ${person}`;
		case 'manager_set':
			return `${who} made ${person} a manager`;
		case 'manager_unset':
			return `${who} made ${person} an ordinary member`;
		case 'shared': {
			const level = LEVEL_NAMES[str(d.level) ?? ''];
			return `${who} shared ${recordText(e)} with the team${level ? ` (${level})` : ''}`;
		}
		case 'unshared':
			return `${who} stopped sharing ${recordText(e)} with the team`;
		case 'approved':
			return `${who} approved ${person} on ${recordText(e)}`;
		case 'declined':
			return `${who} declined ${person} on ${recordText(e)}`;
		case 'trust_set':
			return `${who} trusted future members on ${recordText(e)}`;
		case 'trust_unset':
			return `${who} stopped trusting future members on ${recordText(e)}`;
		default:
			return `${who}: ${e.kind}`;
	}
}

// ---- Waiting for you (Home) ----

/** "Femi Noor joined Additive · 12 of your records". */
export const pendingLine = (p: Pick<PendingItem, 'full_name' | 'team_name' | 'records'>): string =>
	`${p.full_name || 'Someone'} joined ${p.team_name} · ${p.records.length} of your records`;

// ---- adding a member ----

/** What happened when a member was added, from the endpoint's answer. */
export function addedLines(name: string, team: string, r: { pending: number; owners_asked: number; owned_edit: number }): string[] {
	const lines = [`${name} is now a member of ${team}.`];
	if (r.pending > 0) {
		lines.push(
			r.pending === 1
				? `The owner of 1 record shared with ${team} will be asked to approve.`
				: `Owners of ${r.pending} records shared with ${team} will be asked to approve.`,
		);
	}
	if (r.owned_edit > 0) lines.push(`${name} gets Can edit on the ${plural(r.owned_edit, 'record')} ${team} owns.`);
	return lines;
}

// ---- the logo ----

/** Why a file cannot be the team's logo, or null. `accept` on the input does not stop a dropped file, so the type is checked too. */
export function logoProblem(file: Pick<File, 'type' | 'size'>): string | null {
	if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'The logo must be a PNG, JPEG or SVG image.';
	if (file.size > LOGO_MAX_BYTES) return 'The logo must be 1 MB or smaller.';
	return null;
}
