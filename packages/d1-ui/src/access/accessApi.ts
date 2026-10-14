// The calls of the "Who has access" dialog: the d1-record-access endpoint (core/extensions/d1-record-access) and the People
// search. Every call returns plain data or the endpoint's own message; nothing throws, so the dialog shows the text it is given.
//
// The endpoint answers with the bare JSON (no `data` wrapper), /items answers with `{ data: [...] }`.
import type { ExplorerHost } from '../host';
import { errorText } from '../format';
import { listTeams } from '../teams/teamsApi';
import { peopleSearchQuery, teamHitOf, type AccessEntry, type AccessList, type BlockedBy, type PersonHit, type TeamHit, type TeamMembers } from './accessModel';

export type AccessApi = ExplorerHost['api'];

export type Outcome<T> = { ok: true; data: T } | { ok: false; message: string };

export type EmailResult = 'sent' | 'failed' | 'skipped';

const base = (collection: string, id: string) => `/d1-record-access/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;

async function run<T>(work: () => Promise<T>): Promise<Outcome<T>> {
	try {
		return { ok: true, data: await work() };
	} catch (e) {
		return { ok: false, message: errorText(e, 'Could not reach the server.') };
	}
}

/** The list the caller may see (404 when they cannot read the record). */
export const loadAccess = (api: AccessApi, collection: string, id: string): Promise<Outcome<AccessList>> =>
	run(async () => {
		const body = (await api.get(base(collection, id))).data ?? {};
		return {
			restricted: body.restricted === true,
			owner: body.owner ?? null,
			project_pi: body.project_pi ?? null,
			can_manage: body.can_manage === true,
			entries: Array.isArray(body.entries) ? body.entries : [],
			teams: Array.isArray(body.teams) ? body.teams : [],
		};
	});

export const addEntry = (api: AccessApi, collection: string, id: string, personId: string, role: string): Promise<Outcome<{ entry: AccessEntry | null; email: EmailResult }>> =>
	run(async () => {
		const body = (await api.post(`${base(collection, id)}/entries`, { person_id: personId, role })).data ?? {};
		return { entry: body.entry ?? null, email: body.email ?? 'skipped' };
	});

export const setRole = (api: AccessApi, collection: string, id: string, personId: string, role: string): Promise<Outcome<{ entry: AccessEntry | null }>> =>
	run(async () => {
		const body = (await api.patch(`${base(collection, id)}/entries/${encodeURIComponent(personId)}`, { role })).data ?? {};
		return { entry: body.entry ?? null };
	});

export const removeEntry = (api: AccessApi, collection: string, id: string, personId: string): Promise<Outcome<true>> =>
	run(async () => {
		await api.delete(`${base(collection, id)}/entries/${encodeURIComponent(personId)}`);
		return true as const;
	});

/** The new owner's name and `blocked_by` come back too: the dialog says when they cannot read the record yet (the change is made anyway). */
export const transfer = (
	api: AccessApi,
	collection: string,
	id: string,
	personId: string,
): Promise<Outcome<{ email: EmailResult; owner: { name: string } | null; blocked_by: BlockedBy | null }>> =>
	run(async () => {
		const body = (await api.post(`${base(collection, id)}/transfer`, { person_id: personId })).data ?? {};
		return { email: body.email ?? 'skipped', owner: body.owner ?? null, blocked_by: body.blocked_by ?? null };
	});

/** Active people by name. An empty search is not sent. */
export const searchPeople = (api: AccessApi, text: string, limit?: number): Promise<Outcome<PersonHit[]>> =>
	run(async () => {
		if (!text.trim()) return [];
		// The filter goes as JSON, like the kit's other /items reads (any host's HTTP client sends that the same way).
		const q = peopleSearchQuery(text, limit);
		const res = await api.get('/items/people', { params: { ...q, filter: JSON.stringify(q.filter) } });
		return (res.data?.data ?? []) as PersonHit[];
	});

// ---- teams: a team's grant on the record (the endpoint's /entries/team/... routes) and the add box's team list ----

const teamBase = (collection: string, id: string, teamId: string) => `${base(collection, id)}/entries/team/${encodeURIComponent(teamId)}`;

export const addTeamEntry = (api: AccessApi, collection: string, id: string, teamId: string, role: string): Promise<Outcome<{ email: EmailResult }>> =>
	run(async () => {
		const body = (await api.post(`${base(collection, id)}/entries`, { team_id: teamId, role })).data ?? {};
		return { email: body.email ?? 'skipped' };
	});

/** The level and/or whether later joiners are trusted. */
export const setTeamEntry = (
	api: AccessApi,
	collection: string,
	id: string,
	teamId: string,
	patch: { role?: string; trust_new_members?: boolean },
): Promise<Outcome<true>> =>
	run(async () => {
		await api.patch(teamBase(collection, id, teamId), patch);
		return true as const;
	});

export const removeTeamEntry = (api: AccessApi, collection: string, id: string, teamId: string): Promise<Outcome<true>> =>
	run(async () => {
		await api.delete(teamBase(collection, id, teamId));
		return true as const;
	});

/** Who gets access through the team's grant: active, waiting for an owner's decision, declined. */
export const loadTeamMembers = (api: AccessApi, collection: string, id: string, teamId: string): Promise<Outcome<TeamMembers>> =>
	run(async () => {
		const body = (await api.get(`${teamBase(collection, id, teamId)}/members`)).data ?? {};
		const list = (v: unknown) => (Array.isArray(v) ? v : []);
		return { active: list(body.active), pending: list(body.pending), declined: list(body.declined) };
	});

export const decideTeamMember = (
	api: AccessApi,
	collection: string,
	id: string,
	teamId: string,
	personId: string,
	decision: 'approve' | 'decline',
): Promise<Outcome<{ decision: string; email: EmailResult | undefined }>> =>
	run(async () => {
		const body = (await api.post(`${teamBase(collection, id, teamId)}/members/${encodeURIComponent(personId)}`, { decision })).data ?? {};
		return { decision: body.decision ?? decision, email: body.email };
	});

/** Every team as an add-box hit; the box filters by name itself (GET /d1-teams is one small list). */
export const loadTeamHits = (api: AccessApi): Promise<Outcome<TeamHit[]>> => run(async () => (await listTeams(api)).map(teamHitOf));
