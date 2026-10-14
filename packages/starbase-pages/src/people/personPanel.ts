// What the person panel decides, apart from drawing it: which login action a viewer may use, how an access record is worded, and
// whether an Esc press belongs to the panel. No Vue, so it is unit-tested.
import type { AccessList, AccessRecord, PersonAccess } from './peopleApi';
import type { PeopleRow } from './peopleQuery';

export type LoginActionKind = 'suspend' | 'reactivate' | 'resend' | 'invite';

export interface LoginLine {
	/** The login's state in the lab's words: Active, Suspended, Invited, or No login. */
	state: string;
	action: { kind: LoginActionKind; label: string } | null;
}

/** Who is looking: an administrator (Administrator or Lab Admin) and whether they may change accounts (an Administrator only). */
export interface Viewer {
	admin: boolean;
	accounts: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The Login line of the Account section. Suspend and Reactivate change a login, so only an account administrator gets them; Resend and
 * Invite are for any administrator. A login in some other state (draft, archived) is named and has no action.
 */
export function loginLine(row: PeopleRow, viewer: Viewer): LoginLine {
	if (!viewer.admin) return { state: row.login ? cap(row.login.status ?? 'Active') : 'No login', action: null };
	const login = row.login;
	if (!login) return { state: 'No login', action: { kind: 'invite', label: 'Invite' } };
	switch (login.status) {
		case 'active':
			return { state: 'Active', action: viewer.accounts ? { kind: 'suspend', label: 'Suspend' } : null };
		case 'suspended':
			return { state: 'Suspended', action: viewer.accounts ? { kind: 'reactivate', label: 'Reactivate' } : null };
		case 'invited':
			return { state: 'Invited', action: { kind: 'resend', label: 'Resend' } };
		default:
			return { state: login.status ? cap(login.status) : 'No login', action: null };
	}
}

/** The Role select is enabled only for an account administrator, and only when there is a login to give a role to. */
export const canEditRole = (row: PeopleRow, viewer: Viewer): boolean => viewer.accounts && !!row.login && !!row.user_id;

export const ACCESS_LISTS: { id: AccessList; label: string }[] = [
	{ id: 'owns', label: 'Owns' },
	{ id: 'shared', label: 'Shared with them' },
	{ id: 'investigator', label: 'Investigator' },
	{ id: 'teams', label: 'Through teams' },
];

export const countLabel = (n: number): string => `${n} ${n === 1 ? 'record' : 'records'}`;

/** "Waiting for approval: 3 records (2 owners)", or null when nothing is waiting. */
export function waitingLine(a: Pick<PersonAccess, 'waiting' | 'waiting_owners'> | null | undefined): string | null {
	const n = a?.waiting ?? 0;
	if (n <= 0) return null;
	const m = a?.waiting_owners ?? 0;
	return `Waiting for approval: ${countLabel(n)} (${m} ${m === 1 ? 'owner' : 'owners'})`;
}

const LEVELS: Record<string, string> = {
	owner: 'Owner',
	own: 'Owns', // a record the team owns (its owner grant)
	manage: 'Manages (team owner)', // a manager of the team that owns the record (a manage row)
	pi: 'Principal investigator',
	view: 'Can view',
	edit: 'Can edit',
	investigator: 'Investigator',
};
/** An access level as the lab words it; a level this does not know is shown as it came. */
export const levelLabel = (level: string | null): string => (level ? (LEVELS[level] ?? level) : '');

export const kindLabel = (kind: string | null): string => (kind ? cap(kind) : 'Record');

export type SourceNote = { remove: true } | { remove: false; text: string } | null;

/**
 * What an administrator can do about one listed record. A direct entry (`access`) can be removed here; any other source is shown for
 * what it is and changed where it lives. Nothing for a viewer who is not an administrator.
 */
export function sourceNote(rec: AccessRecord, admin: boolean): SourceNote {
	if (!admin) return null;
	switch (rec.source) {
		case 'access':
			return { remove: true };
		case 'co_owner':
			return { remove: false, text: 'co-owner (old entry)' };
		case 'investigator_junction':
			return { remove: false, text: 'old entry, change on the project' };
		case 'pi':
			return { remove: false, text: 'change on the project' };
		case 'team':
			return { remove: false, text: 'through the team' };
		case 'team_owner':
			return { remove: false, text: 'through the team that owns it' };
		default:
			return { remove: false, text: `change on the ${(rec.kind ?? 'record').toLowerCase()}` };
	}
}

/**
 * What Esc may belong to instead of the panel: a Directus dialog or drawer (all mounted into #dialog-outlet), any aria-modal dialog, and
 * a menu list (Directus portals its select and menu lists as .v-menu-content; this page's own menus carry data-open-menu).
 */
export const ESC_OWNER_SELECTOR = '#dialog-outlet > *, [aria-modal="true"], .v-menu-content, [data-open-menu]';

/** Should an Esc press close the panel? Not when something else already took it, when focus is in a (native) select, or when a dialog or menu is open. */
export function escapeClosesPanel(e: { key: string; defaultPrevented: boolean }, focusTag: string | null | undefined, overlayOpen: boolean): boolean {
	if (e.key !== 'Escape' || e.defaultPrevented || overlayOpen) return false;
	return (focusTag ?? '').toLowerCase() !== 'select';
}
