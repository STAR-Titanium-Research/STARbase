// The "Who has access" dialog's pure parts (spec docs/superpowers/specs/2026-10-12-record-access-design.md sections 1 and 6):
// role labels per record type, ordering, who may change what, the texts, and the people search. No Vue, no host.
//
// The data comes from GET /d1-record-access/:collection/:id (core/extensions/d1-record-access). Its entries are the
// access table and the old co-owner / investigator rows merged by person, strongest role first.

import type { TeamColor } from '../teams/teamPalette';
import type { TeamSummary } from '../teams/teamsApi';

export type AccessCollection = 'physical_samples' | 'manufacturing_operations' | 'test_sessions' | 'campaigns' | 'projects';

export const ACCESS_COLLECTIONS: AccessCollection[] = ['physical_samples', 'manufacturing_operations', 'test_sessions', 'campaigns', 'projects'];

export const isAccessCollection = (collection: string): collection is AccessCollection =>
	(ACCESS_COLLECTIONS as string[]).includes(collection);

/** The Restrict switch (spec section 1): the component exists, nothing draws it until A1b flips this one line. */
export const RESTRICT_UI = false;

export interface AccessPerson {
	/** The endpoint says which kind of owner it sends (older answers have no `kind`: a person). */
	kind?: 'person';
	person_id: string;
	name: string;
	can_sign_in: boolean;
}

/**
 * Why a person cannot read the record yet. `no_login`: they have no login (the "can't sign in yet" tag already says it).
 * `parent`: they have a login that is not among the record's readers; collection, id, kind and code name the nearest parent they cannot
 * read, and are all null when the server will not name one (the caller cannot read it either): the text is then generic.
 */
export interface BlockedBy {
	reason?: 'parent' | 'no_login';
	collection: string | null;
	id: string | null;
	kind: string | null;
	code: string | null;
}

export interface AccessEntry {
	/** null: an old co-owner / investigator whose login has no People row. Listed, but cannot be changed or removed. */
	person_id: string | null;
	name: string;
	role: string;
	/** The server's wording; the dialog words roles itself (entryLabel) so a sample's Can edit always reads as a co-owner. */
	label?: string;
	source: 'access' | 'co_owner' | 'investigator';
	can_sign_in: boolean;
	added_by: string | null;
	added_at: string | null;
	blocked_by: BlockedBy | null;
}

/**
 * A team the record is shared with (the endpoint's `teams`). `waiting`: members who joined after the share and wait for an owner's
 * decision; `declined`: those the owner declined. `trust_new_members`: later joiners get access without being asked about.
 */
export interface TeamAccess {
	team_access_id: string;
	team_id: string;
	name: string;
	color: TeamColor;
	logo: string | null;
	member_count: number;
	role: string;
	trust_new_members: boolean;
	waiting: number;
	declined: number;
}

/** A team that owns the record (the four ownable types): its managers act as the owner. */
export interface AccessTeamOwner {
	kind: 'team';
	team_id: string;
	name: string;
	color: TeamColor;
	logo: string | null;
	managers: { person_id: string; full_name: string | null }[];
}

export type AccessOwner = AccessPerson | AccessTeamOwner;

export const isTeamOwner = (owner: unknown): owner is AccessTeamOwner => !!owner && (owner as AccessTeamOwner).kind === 'team';

/** The owner row's words: the person's name, or "Additive (managers)" for a team (its managers act as the owner). */
export const ownerRowText = (owner: AccessOwner | null): string => (!owner ? 'No owner' : isTeamOwner(owner) ? `${owner.name} (managers)` : owner.name);

/** The managers under a team owner's row, comma separated; empty for a person or a team with none. */
export const ownerManagersText = (owner: AccessOwner | null): string =>
	isTeamOwner(owner) ? owner.managers.map((m) => m.full_name || 'Unnamed').join(', ') : '';

export interface AccessList {
	restricted: boolean;
	owner: AccessOwner | null;
	project_pi: AccessPerson | null;
	can_manage: boolean;
	entries: AccessEntry[];
	teams: TeamAccess[];
}

/** A People row as the add box reads it (`user_id` is the login). */
export interface PersonHit {
	person_id: string;
	full_name: string;
	user_id?: string | null;
}

/** A team as the add box offers it (from GET /d1-teams). */
export interface TeamHit {
	kind: 'team';
	team_id: string;
	name: string;
	color: TeamColor;
	logo: string | null;
	member_count: number;
}

export const isTeamHit = (hit: PersonHit | TeamHit): hit is TeamHit => (hit as TeamHit).kind === 'team';

/** One person under a team grant: GET .../entries/team/:team_id/members. `actionable` is false for a joiner nobody needs to be asked about. */
export interface TeamMemberRow {
	person_id: string;
	name: string;
	can_sign_in: boolean;
	actionable?: boolean;
	decided_at?: string | null;
}

export interface TeamMembers {
	active: TeamMemberRow[];
	pending: TeamMemberRow[];
	declined: TeamMemberRow[];
}

export interface RoleOption {
	role: 'view' | 'edit' | 'investigator';
	label: string;
}

/** The roles a record type offers, in order. Projects: Can view and Secondary investigator; nobody but the PI edits one. */
export function ROLE_LABELS(collection: string): RoleOption[] {
	return collection === 'projects'
		? [
				{ role: 'view', label: 'Can view' },
				{ role: 'investigator', label: 'Secondary investigator' },
			]
		: [
				{ role: 'view', label: 'Can view' },
				{ role: 'edit', label: 'Can edit' },
			];
}

/** The words next to the owner: a project's owner is its principal investigator. */
export const ownerWord = (collection: string): string => (collection === 'projects' ? 'Principal investigator' : 'Owner');

/** What a record is called in a sentence ("this sample"). */
export function recordWord(collection: string): string {
	switch (collection) {
		case 'physical_samples': return 'sample';
		case 'manufacturing_operations': return 'operation';
		case 'test_sessions': return 'test';
		case 'campaigns': return 'campaign';
		case 'projects': return 'project';
		default: return 'record';
	}
}

/** The role as the list prints it. On a sample a Can edit person is a co-owner. */
export function entryLabel(entry: Pick<AccessEntry, 'role' | 'source'>, collection: string): string {
	if (entry.role === 'investigator') return 'Secondary investigator';
	if (entry.role === 'edit') return collection === 'physical_samples' ? 'Co-owner · can edit' : 'Can edit';
	if (entry.role === 'view') return 'Can view';
	return entry.role;
}

const RANK: Record<string, number> = { investigator: 2, edit: 2, view: 1 };

/** Strongest role first, then by name. Returns a new array. */
export function sortEntries<T extends Pick<AccessEntry, 'role' | 'name'>>(entries: T[]): T[] {
	return [...entries].sort((a, b) => (RANK[b.role] ?? 0) - (RANK[a.role] ?? 0) || a.name.localeCompare(b.name));
}

/** Teams: strongest level first, then by name. Returns a new array. */
export function sortTeams<T extends Pick<TeamAccess, 'role' | 'name'>>(teams: T[]): T[] {
	return sortEntries(teams);
}

/** A team's level as the row prints it. A team never owns anything, so a sample's Can edit is plain "Can edit" (not "Co-owner"). */
export function teamRoleLabel(role: string): string {
	if (role === 'investigator') return 'Secondary investigator';
	if (role === 'edit') return 'Can edit';
	if (role === 'view') return 'Can view';
	return role;
}

/** The line under a team's name. */
export const teamMembersLabel = (count: number): string => `Team · ${count} member${count === 1 ? '' : 's'}`;

/** "2 waiting · 1 declined" for the manager of the record; null when nobody waits and nobody was declined. */
export function teamBacklogText(team: Pick<TeamAccess, 'waiting' | 'declined'>): string | null {
	return team.waiting || team.declined ? `${team.waiting} waiting · ${team.declined} declined` : null;
}

/** The waiting people the owner is asked about (a joiner the server marks not actionable is left out). */
export const waitingMembers = (pending: TeamMemberRow[]): TeamMemberRow[] => pending.filter((m) => m.actionable !== false);

export const teamHitOf = (team: TeamSummary): TeamHit => ({
	kind: 'team', team_id: team.team_id, name: team.name, color: team.color, logo: team.logo ?? null, member_count: team.member_count,
});

/** The add box's teams: names containing the text (client-side: the list is small), by name, without the teams the record has already. */
export function teamsMatching(teams: TeamHit[], text: string, list: { teams?: Pick<TeamAccess, 'team_id'>[] }, limit = 5): TeamHit[] {
	const needle = text.trim().toLowerCase();
	if (!needle) return [];
	const taken = new Set((list.teams ?? []).map((t) => t.team_id));
	return teams
		.filter((t) => !taken.has(t.team_id) && t.name.toLowerCase().includes(needle))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, limit);
}

/** Role selector and Remove are drawn only for a manager, and never for a row the endpoint cannot address (no People row). */
export const canChangeRole = (entry: Pick<AccessEntry, 'person_id'>, canManage: boolean): boolean => canManage && !!entry.person_id;

/** Active people whose name contains the text: the add box's request (the same /items/people the People page reads). */
export function peopleSearchQuery(text: string, limit = 8): Record<string, unknown> {
	return {
		filter: { _and: [{ active: { _eq: true } }, { full_name: { _icontains: text.trim() } }] },
		fields: ['person_id', 'full_name', 'user_id'],
		sort: ['full_name'],
		limit,
	};
}

/** A person with no login can be added, but the grant starts working only when an admin links a login to them. */
export const isLoginless = (person: { user_id?: string | null; can_sign_in?: boolean }): boolean =>
	person.can_sign_in !== undefined ? !person.can_sign_in : !person.user_id;

export const LOGINLESS_NOTE = "can't sign in yet";

/** The two letters in a person's avatar circle: first letters of the first and last word. */
export function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	if (!words.length) return '?';
	const first = words[0][0];
	const last = words.length > 1 ? words[words.length - 1][0] : '';
	return (first + last).toUpperCase();
}

/** Search hits without the people already on the list, the owner and the project's PI (they have access already). */
export function addable(hits: PersonHit[], list: Pick<AccessList, 'owner' | 'entries'>): PersonHit[] {
	const taken = new Set<string>();
	if (list.owner && !isTeamOwner(list.owner)) taken.add(list.owner.person_id);
	for (const e of list.entries) if (e.person_id) taken.add(e.person_id);
	return hits.filter((h) => !taken.has(h.person_id));
}

/** The four types a team can own (a project's owner is its principal investigator, a person). */
export const transferOffersTeams = (collection: string): boolean => isAccessCollection(collection) && collection !== 'projects';

/**
 * What the transfer picker leaves out: only the owner (a record's grants do not matter for ownership), where the add box leaves out
 * everyone already on the record. A team that owns the record is offered by neither.
 */
export function pickerTaken(
	list: Pick<AccessList, 'owner' | 'entries'> & { teams?: Pick<TeamAccess, 'team_id'>[] },
	entries: boolean,
): Pick<AccessList, 'owner' | 'entries'> & { teams?: Pick<TeamAccess, 'team_id'>[] } {
	if (entries) {
		// the owning team has no entry of its own (Ruling O2) yet cannot be given another grant on its own record (409 TEAM_OWNS_RECORD)
		return isTeamOwner(list.owner) ? { ...list, teams: [...(list.teams ?? []), { team_id: list.owner.team_id }] } : list;
	}
	return { owner: list.owner, entries: [], teams: isTeamOwner(list.owner) ? [{ team_id: list.owner.team_id }] : [] };
}

/** The name of a person or team the add box found. */
export const hitName = (hit: PersonHit | TeamHit): string => (isTeamHit(hit) ? hit.name : hit.full_name);

/**
 * The confirm step of an ownership transfer. The previous PERSON owner stays on the record (Can edit; Secondary investigator on a
 * project) so the record never disappears for the person who made it. `byOwner`: the person asking is the owner, so "you stay";
 * an admin transferring someone else's record reads "<name> stays". No previous owner: nobody stays.
 * `fromTeam` (Ruling O5): the owner is a team, and its managers do NOT stay: they lose access unless added back, so the text says so.
 * `toTeam`: the new owner is a team, so its managers (not one person) decide from now on.
 */
export function transferConfirmText(from: string | null, to: string, collection: string, byOwner = true, opts: { fromTeam?: boolean; toTeam?: boolean } = {}): string {
	const kept = ROLE_LABELS(collection).find((r) => r.role === (collection === 'projects' ? 'investigator' : 'edit'))!.label;
	const becomes = `${to} becomes ${collection === 'projects' ? 'the principal investigator' : 'the owner'}.`;
	let stays = '';
	if (opts.fromTeam && from) {
		stays = byOwner
			? ` You and the other managers of ${from} will lose access unless you are added back.`
			: ` The managers of ${from} will lose access unless they are added back.`;
	} else if (from) {
		stays = ` ${byOwner ? 'You stay' : `${from} stays`} on the record as ${kept}.`;
	}
	const who = opts.toTeam ? `${to}'s managers` : `the new ${collection === 'projects' ? 'principal investigator' : 'owner'}`;
	return `${becomes}${stays} Only ${who} can change who has access.`;
}

/** What a person who may read but not manage sees instead of the controls. */
export function noManagerText(owner: Pick<AccessPerson, 'name'> | Pick<AccessTeamOwner, 'kind' | 'name'> | null): string {
	if (!owner) return 'Only an admin can change who has access.';
	if ((owner as AccessTeamOwner).kind === 'team') return `Only ${owner.name}'s managers can change who has access.`;
	return `Only ${owner.name} can change who has access.`;
}

/**
 * "<name> cannot see <parent>, so this will not take effect until its owner adds them." Null when nothing blocks the grant, and for a
 * person with no login (the "can't sign in yet" tag says that). With no parent named (the caller may not know it exists) the words are generic.
 */
export function blockedText(entry: { name: string; blocked_by?: BlockedBy | null }): string | null {
	const b = entry.blocked_by;
	if (!b || b.reason === 'no_login') return null;
	const parent = [b.kind, b.code].filter(Boolean).join(' ');
	if (!parent) return `${entry.name} cannot see this record yet, so this will not take effect until they are given access to what it sits under.`;
	return `${entry.name} cannot see ${parent}, so this will not take effect until its owner adds them.`;
}

/** The project PI line under the list (a project's own PI is its owner, so there is no extra line there). */
export function piNote(list: Pick<AccessList, 'project_pi'>, collection: string): string | null {
	if (collection === 'projects' || !list.project_pi) return null;
	return `Project PI: ${list.project_pi.name}, sees everything in the project.`;
}

/** Record kind (as the endpoint names it) -> the Explorer route segment. A test pins this against recordRoute(). */
export const RECORD_LINK_KINDS: Record<string, string> = {
	sample: 'samples',
	operation: 'operations',
	test: 'tests',
	campaign: 'campaigns',
	project: 'projects',
};

/** An operation or test on an unrestricted sample is also reachable through the sample's list (read-only in the dialog). */
export function showInherited(own: Pick<AccessList, 'restricted'>, parent: Pick<AccessList, 'restricted'> | null): boolean {
	return !!parent && !own.restricted && !parent.restricted;
}

/** The email result of a write as one quiet line, or null when nothing needs saying. */
export function emailNote(email: string | undefined, what: 'added' | 'owner' | 'team'): string | null {
	if (email !== 'failed') return null;
	if (what === 'team') return 'Added. Some emails could not be sent.';
	return what === 'added' ? 'Added. The email could not be sent.' : 'Ownership transferred. The email could not be sent.';
}
