// The People page's calls: the d1-people-admin endpoint (core/extensions/d1-people-admin) and, for a member who may not call it,
// /items/people. Each call returns the endpoint's parsed JSON and throws an Error carrying the endpoint's own message
// (errors[0].message) so the page shows the text it is given.
import { errorText, type HostApi } from '@d1/ui';
import type { PeopleLogin, PeopleRow } from './peopleQuery';

const BASE = '/d1-people-admin';

export interface RoleOption {
	id: string;
	name: string | null;
}

/** A login that has no person, as d1-people-admin lists it. */
export interface LoginWithoutPerson {
	user_id: string;
	email: string | null;
	first_name: string | null;
	last_name: string | null;
	status: string | null;
	role_id: string | null;
	role_name: string | null;
	last_access: string | null;
}

export interface PeopleData {
	/** An account administrator (not a Lab Admin): the only one who may change a login's role or status. */
	canAdministerAccounts: boolean;
	roles: RoleOption[];
	rows: PeopleRow[];
}

export interface AttentionItem {
	key: string;
	count: number;
}

export type AccessList = 'owns' | 'shared' | 'investigator';

export interface AccessRecord {
	collection: string;
	id: string;
	kind: string | null;
	code: string | null;
	title: string | null;
	level: string | null;
	source: string | null;
	granted_by: string | null;
	added_at: string | null;
}

export interface PersonAccess {
	owns: number;
	shared: number;
	investigator: number;
	/** Present when a list was asked for. */
	records?: AccessRecord[];
}

/**
 * What a failed call throws: the endpoint's message, plus its HTTP status, error code and `extensions` so a page can act on them
 * (the invite dialog answers 409 EMAIL_HAS_LOGIN with extensions.person_id, "link to this person instead"). All unset for a network error.
 */
export class PeopleApiError extends Error {
	status?: number;
	code?: string;
	extensions?: Record<string, unknown>;
	constructor(message: string, detail: { status?: number; code?: string; extensions?: Record<string, unknown> } = {}) {
		super(message);
		this.name = 'PeopleApiError';
		this.status = detail.status;
		this.code = detail.code;
		this.extensions = detail.extensions;
	}
}

async function call<T>(work: () => Promise<{ data: any }>, shape: (body: any) => T): Promise<T> {
	let body: unknown;
	try {
		body = (await work()).data;
	} catch (e: any) {
		const first = e?.response?.data?.errors?.[0];
		throw new PeopleApiError(errorText(e, 'Could not reach the server.'), {
			status: e?.response?.status,
			code: first?.extensions?.code,
			extensions: first?.extensions,
		});
	}
	return shape(body ?? {});
}

// A login without a person only becomes a row while it is a usable login: archived and draft ones are not people the lab can act on.
const LISTED_LOGIN = new Set(['active', 'invited', 'suspended']);

function loginRow(l: LoginWithoutPerson): PeopleRow {
	const name = [l.first_name, l.last_name].filter(Boolean).join(' ').trim();
	const login: PeopleLogin = { status: l.status, role_id: l.role_id, role_name: l.role_name, last_access: l.last_access, email: l.email };
	return {
		kind: 'login',
		person_id: null,
		full_name: name || l.email || l.user_id,
		email: l.email,
		is_researcher: false,
		is_operator: false,
		active: true,
		notes: null,
		user_id: l.user_id,
		login,
		attention: ['login_without_person'],
	};
}

// A member's /items/people row: no login and no attention (those are the administrator endpoint's).
const memberRow = (p: any): PeopleRow => ({
	kind: 'person',
	person_id: p.person_id,
	full_name: p.full_name ?? '',
	email: p.email ?? null,
	is_researcher: p.is_researcher === true,
	is_operator: p.is_operator === true,
	active: p.active !== false,
	notes: p.notes ?? null,
	user_id: p.user_id ?? null,
	login: null,
	attention: [],
	created_at: p.created_at ?? null,
});

/** Everyone the caller may see. An administrator gets logins, roles and attention; a member only the names (the endpoint is closed to them). */
export function loadPeople(api: HostApi, isAdmin: boolean): Promise<PeopleData> {
	if (!isAdmin) {
		return call(
			() => api.get('/items/people', { params: { limit: -1, sort: 'full_name' } }),
			(body) => ({ canAdministerAccounts: false, roles: [], rows: (Array.isArray(body.data) ? body.data : []).map(memberRow) }),
		);
	}
	return call(
		() => api.get(`${BASE}/people`),
		(body) => ({
			canAdministerAccounts: body.can_administer_accounts === true,
			roles: Array.isArray(body.roles) ? body.roles : [],
			rows: [
				...(Array.isArray(body.people) ? body.people : []).map((p: any): PeopleRow => ({ ...p, kind: 'person' })),
				...(Array.isArray(body.logins_without_person) ? body.logins_without_person : [])
					.filter((l: LoginWithoutPerson) => LISTED_LOGIN.has(l.status ?? ''))
					.map(loginRow),
			],
		}),
	);
}

/** The "Needs attention" counts (zero counts are left out by the endpoint). Administrators only. */
export const loadAttention = (api: HostApi): Promise<AttentionItem[]> =>
	call(() => api.get(`${BASE}/attention`), (body) => (Array.isArray(body.items) ? body.items : []));

/** The three counts of what a person owns / has shared with them / investigates, and the records of one list when asked. */
export const loadAccess = (api: HostApi, personId: string, list?: AccessList): Promise<PersonAccess> =>
	call(
		() => api.get(`${BASE}/people/${encodeURIComponent(personId)}/access`, list ? { params: { list } } : undefined),
		(body) => body as PersonAccess,
	);

export interface LoginPatch {
	role?: string;
	status?: 'active' | 'suspended';
}
export interface LoginState {
	user_id: string;
	role_id: string | null;
	role_name: string | null;
	status: string | null;
}

/** Change a login's role or suspend/reactivate it. Account administrators only. */
export const patchLogin = (api: HostApi, userId: string, body: LoginPatch): Promise<LoginState> =>
	call(() => api.patch(`${BASE}/logins/${encodeURIComponent(userId)}`, body), (b) => b as LoginState);

export interface InviteBody {
	email: string;
	role?: string;
	person_id?: string;
	full_name?: string;
}
export interface InviteResult {
	user_id: string;
	person_id: string;
	status: 'invited';
	email_sent: boolean;
}

/** Invite by e-mail. The endpoint answers 201 for a new login and 200 when it sends the invite again: both are success. */
export const invite = (api: HostApi, body: InviteBody): Promise<InviteResult> =>
	call(() => api.post(`${BASE}/invite`, body), (b) => b as InviteResult);

/** Send the invite again to a login that has not accepted it. */
export const resendInvite = (api: HostApi, userId: string): Promise<{ email_sent: boolean }> =>
	call(() => api.post(`${BASE}/invite/resend`, { user_id: userId }), (b) => b as { email_sent: boolean });

/** Take a person's direct access to one record away (the Who-has-access endpoint). */
export const removeDirectGrant = (api: HostApi, collection: string, recordId: string, personId: string): Promise<{ removed: boolean }> =>
	call(
		() => api.delete(`/d1-record-access/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}/entries/${encodeURIComponent(personId)}`),
		(b) => b as { removed: boolean },
	);
