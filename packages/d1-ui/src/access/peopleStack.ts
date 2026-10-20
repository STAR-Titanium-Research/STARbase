// The people row of the Project page hero (spec docs/superpowers/specs/2026-10-20-project-page-hero-design.md, "People row"):
// everyone in "Who has access", as an ordered stack of faces and the counts for the line beside it. No Vue, no host.
//
// Order: the owner (a project's PI) first, then secondary investigators, then people and teams who can edit, then those who can view;
// inside a level the people come first, then the teams, each by name (the dialog's own sort).

import { initials, isTeamOwner, sortEntries, sortTeams, type AccessList } from './accessModel';

/** Faces drawn in full; up to FADE_OPACITIES.length more follow, each fainter. */
export const FACES_SHOWN = 6;
export const FADE_OPACITIES: readonly number[] = [0.5, 0.26, 0.1];

export interface PersonFace {
	key: string;
	/** "Dennis Premoli: Principal investigator", for the tooltip and screen readers. */
	label: string;
	/** Empty for a team (it shows the groups icon). */
	initials: string;
	team: boolean;
	pi: boolean;
	opacity: number;
}

export interface PeopleStack {
	faces: PersonFace[];
	/** The PI's name for the line beside the faces ("" when there is none, and the line is left out). */
	piLabel: string;
	/** Everyone with access: the owner, the people and the teams. */
	total: number;
	/** Secondary investigators (people and teams). */
	investigators: number;
	/** Everyone who is neither the PI nor an investigator. */
	more: number;
}

const LEVELS = ['investigator', 'edit', 'view'] as const;
const roleText = (role: string): string =>
	role === 'investigator' ? 'Secondary investigator' : role === 'edit' ? 'Can edit' : role === 'view' ? 'Can view' : role;
const levelOf = (role: string): number => {
	const i = (LEVELS as readonly string[]).indexOf(role);
	return i < 0 ? LEVELS.length : i;
};

interface Row { key: string; name: string; role: string; team: boolean; pi: boolean }

/**
 * `list` is the endpoint's answer, or null when it could not be read: the stack is then the PI alone (from `piName`, the project's own
 * owner) with no counts. With a list, `piName` only fills in an owner row that has no name.
 */
export function peopleStack(list: Pick<AccessList, 'owner' | 'entries' | 'teams'> | null, piName = ''): PeopleStack {
	const rows: Row[] = [];
	const owner = list?.owner ?? null;
	const ownerName = (owner?.name || piName).trim();
	if (owner || ownerName) {
		rows.push({
			key: owner ? (isTeamOwner(owner) ? `team:${owner.team_id}` : `person:${owner.person_id}`) : 'pi',
			name: ownerName || 'Unnamed',
			role: 'owner',
			team: isTeamOwner(owner),
			pi: true,
		});
	}
	if (list) {
		const ownerId = owner && !isTeamOwner(owner) ? owner.person_id : null;
		const ownerTeam = owner && isTeamOwner(owner) ? owner.team_id : null;
		const people = sortEntries(list.entries.filter((e) => !ownerId || e.person_id !== ownerId)).map<Row>((e, i) => ({
			key: e.person_id ? `person:${e.person_id}` : `entry:${i}:${e.name}`, name: e.name, role: e.role, team: false, pi: false,
		}));
		const teams = sortTeams((list.teams ?? []).filter((t) => t.team_id !== ownerTeam)).map<Row>((t) => ({
			key: `team:${t.team_id}`, name: t.name, role: t.role, team: true, pi: false,
		}));
		// A stable sort by level keeps people before teams, each by name, inside a level.
		rows.push(...[...people, ...teams].sort((a, b) => levelOf(a.role) - levelOf(b.role)));
	}

	const investigators = rows.filter((r) => !r.pi && r.role === 'investigator').length;
	const faces = rows.slice(0, FACES_SHOWN + FADE_OPACITIES.length).map<PersonFace>((r, i) => ({
		key: r.key,
		label: `${r.name}: ${r.pi ? 'Principal investigator' : roleText(r.role)}`,
		initials: r.team ? '' : initials(r.name),
		team: r.team,
		pi: r.pi,
		opacity: i < FACES_SHOWN ? 1 : FADE_OPACITIES[i - FACES_SHOWN],
	}));
	const hasPi = rows.some((r) => r.pi);
	return { faces, piLabel: ownerName, total: rows.length, investigators, more: rows.length - (hasPi ? 1 : 0) - investigators };
}
