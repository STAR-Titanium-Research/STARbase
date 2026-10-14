// The calls of the d1-teams endpoint (core/extensions/d1-teams; its header comment is the contract). The endpoint answers with the bare
// JSON (no `data` wrapper); /files answers with Directus's `{ data }`. A failed call throws a TeamsApiError carrying the endpoint's own
// message, so a page can show it, plus its HTTP status, error code and `extensions` so a page can act on them (LAST_MANAGER, TEAM_NAME_TAKEN,
// NO_PERSON, BAD_LOGO...). All three are unset for a network error.
import type { HostApi } from '../host';
import { errorText } from '../format';
import type { TeamColor } from './teamPalette';

export class TeamsApiError extends Error {
	status?: number;
	code?: string;
	extensions?: Record<string, unknown>;
	constructor(message: string, detail: { status?: number; code?: string; extensions?: Record<string, unknown> } = {}) {
		super(message);
		this.name = 'TeamsApiError';
		this.status = detail.status;
		this.code = detail.code;
		this.extensions = detail.extensions;
	}
}

/** A team as GET /d1-teams lists it. `color` is one of the ten palette keys. */
export interface TeamSummary {
	team_id: string;
	name: string;
	description: string | null;
	color: TeamColor;
	logo: string | null;
	member_count: number;
	managers: { person_id: string; full_name: string | null }[];
	is_member: boolean;
	is_manager: boolean;
}

export interface TeamMember {
	person_id: string;
	full_name: string | null;
	can_sign_in: boolean;
	is_manager: boolean;
	joined_at: string | null;
}

export type TeamLevel = 'view' | 'edit' | 'investigator';

/** The records of a team per access level; `owns` is the records the team OWNS (owner_team_id), whose owner grant is a record with role 'own'. */
export type TeamCounts = Record<TeamLevel, number> & { owns?: number };

export interface TeamRecord {
	collection: string;
	id: string;
	kind: string | null;
	code: string | null;
	title: string | null;
	role: string;
}

export interface TeamEvent {
	event_id: number;
	at: string | null;
	kind: string;
	actor_person_id: string | null;
	actor_name: string | null;
	person_id: string | null;
	person_name: string | null;
	collection: string | null;
	record_id: string | null;
	record_kind: string | null;
	record_code: string | null;
	record_hidden: boolean;
	detail: unknown;
}

/** GET /d1-teams/:id. `records` are the granted records the caller reads; `hidden_count` is the rest. */
export interface TeamDetail {
	team: TeamSummary;
	members: TeamMember[];
	counts: TeamCounts;
	records: TeamRecord[];
	hidden_count: number;
	events: TeamEvent[];
}

export interface PendingItem {
	team_id: string;
	team_name: string;
	person_id: string;
	full_name: string | null;
	records: TeamRecord[];
}

export interface TeamEdit {
	name?: string;
	description?: string | null;
	color?: TeamColor;
	/** A directus_files id (see uploadTeamLogo), or null to clear it. */
	logo?: string | null;
}

export type PendingDecision = 'approve' | 'decline';

const path = (id: string, ...rest: string[]) => ['/d1-teams', encodeURIComponent(id), ...rest.map(encodeURIComponent)].join('/');

async function call<T>(work: () => Promise<{ data: any }>, shape: (body: any) => T): Promise<T> {
	let body: unknown;
	try {
		body = (await work()).data;
	} catch (e: any) {
		const first = e?.response?.data?.errors?.[0];
		throw new TeamsApiError(errorText(e, 'Could not reach the server.'), {
			status: e?.response?.status,
			code: first?.extensions?.code,
			extensions: first?.extensions,
		});
	}
	return shape(body ?? {});
}

const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export const listTeams = (api: HostApi): Promise<TeamSummary[]> => call(() => api.get('/d1-teams'), (b) => asList<TeamSummary>(b.teams));

/** The ids of a team's records of one collection that the caller can read, newest first (GET /d1-teams/:id/records). `truncated`: the team has more than `limit`. */
export interface TeamRecordIds {
	ids: string[];
	truncated: boolean;
}

/** The most the endpoint returns (and the index Team filter asks for). */
export const TEAM_RECORDS_LIMIT = 500;

/** Which records of `collection` a team owns or has a grant on, and the caller reads: the Team filter of the index pages (Ruling M1: only readable ids). */
export const getTeamRecordIds = (api: HostApi, teamId: string, collection: string, limit: number = TEAM_RECORDS_LIMIT): Promise<TeamRecordIds> =>
	call(
		() => api.get(path(teamId, 'records'), { params: { collection, limit } }),
		(b) => ({ ids: asList<unknown>(b.ids).map(String), truncated: b.truncated === true }),
	);

/** One team with its members, counts, readable records and history. `{ events: 'all' }` asks for every event, not the last 20. */
export const getTeam = (api: HostApi, id: string, opts?: { events?: 'all' }): Promise<TeamDetail> =>
	call(
		() => api.get(path(id), opts?.events ? { params: { events: opts.events } } : undefined),
		(b) => ({
			team: b.team,
			members: asList<TeamMember>(b.members),
			counts: { view: 0, edit: 0, investigator: 0, owns: 0, ...(b.counts ?? {}) },
			records: asList<TeamRecord>(b.records),
			hidden_count: Number(b.hidden_count) || 0,
			events: asList<TeamEvent>(b.events),
		}),
	);

/** The caller becomes the new team's manager (409 NO_PERSON when they have no person, 409 TEAM_NAME_TAKEN for a taken name). */
export const createTeam = (api: HostApi, body: { name: string; description?: string; color?: TeamColor }): Promise<TeamSummary> =>
	call(() => api.post('/d1-teams', body), (b) => b as TeamSummary);

export const updateTeam = (api: HostApi, id: string, patch: TeamEdit): Promise<TeamSummary> =>
	call(() => api.patch(path(id), patch), (b) => b as TeamSummary).then(forgetAfter(id));

export const deleteTeam = (api: HostApi, id: string): Promise<{ deleted: boolean; owners_mailed: number }> =>
	call(() => api.delete(path(id)), (b) => ({ deleted: b.deleted === true, owners_mailed: Number(b.owners_mailed) || 0 })).then(forgetAfter(id));

/** `pending`: the joiner's rows worth asking the records' owners about; `owners_asked`: how many owners were mailed. */
export const addMember = (api: HostApi, teamId: string, personId: string, isManager = false): Promise<{ pending: number; owners_asked: number; owned_edit: number }> =>
	call(
		() => api.post(path(teamId, 'members'), { person_id: personId, is_manager: isManager }),
		(b) => ({ pending: Number(b.pending) || 0, owners_asked: Number(b.owners_asked) || 0, owned_edit: Number(b.owned_edit) || 0 }),
	).then(forgetAfter(teamId));

/** Make a member a manager or not (409 LAST_MANAGER for the last manager). */
export const setManager = (api: HostApi, teamId: string, personId: string, isManager: boolean): Promise<void> =>
	call(() => api.patch(path(teamId, 'members', personId), { is_manager: isManager }), () => undefined).then(forgetAfter(teamId));

/** A manager or administrator removes anyone; a person removes themself. 409 LAST_MANAGER for the last manager. */
export const removeMember = (api: HostApi, teamId: string, personId: string): Promise<void> =>
	call(() => api.delete(path(teamId, 'members', personId)), () => undefined).then(forgetAfter(teamId));

/** The joiners waiting on records the caller manages, grouped by joiner and team. */
export const listPending = (api: HostApi): Promise<PendingItem[]> => call(() => api.get('/d1-teams/pending'), (b) => asList<PendingItem>(b.items));

/** Approve or decline one joiner on every record the caller manages, or only on `records` (one the caller does not manage is 403, nothing applied). */
export const decidePending = (
	api: HostApi,
	body: { team_id: string; person_id: string; decision: PendingDecision; records?: { collection: string; id: string }[] },
): Promise<{ decision: PendingDecision; decided: number; records: { collection: string; id: string }[] }> =>
	call(
		() => api.post('/d1-teams/pending/decide', body),
		(b) => ({ decision: b.decision, decided: Number(b.decided) || 0, records: asList(b.records) }),
	);

/** Upload an image to Directus (POST /files) and return the file's id, for updateTeam({ logo }). The endpoint checks type (png, jpeg, svg) and size (1 MB). */
export const uploadTeamLogo = (api: HostApi, file: File): Promise<string> =>
	call(
		() => {
			const form = new FormData();
			form.append('file', file);
			return api.post('/files', form);
		},
		(b) => {
			const id = b?.data?.id;
			if (typeof id !== 'string' || !id) throw new TeamsApiError('The upload did not return a file.');
			return id;
		},
	);

// The members card (TeamCard) and the face stacks of the access dialog read the same team many times on one page: the answer is kept per
// page load. A failed read is forgotten so the next hover retries. A change drops it (clearTeamCache) and tells the mounted cards (onTeamChange).
const cache = new Map<string, Promise<TeamDetail>>();

export function cachedTeam(api: HostApi, id: string): Promise<TeamDetail> {
	let p = cache.get(id);
	if (!p) {
		p = getTeam(api, id);
		cache.set(id, p);
		p.catch(() => {
			if (cache.get(id) === p) cache.delete(id);
		});
	}
	return p;
}

// A change to a team (its details or members) makes the kept read stale: drop it once the write has succeeded, so the next card reads afresh.
function forgetAfter(id: string) {
	return <T>(result: T): T => {
		clearTeamCache(id);
		return result;
	};
}

// Who is showing a team: a mounted TeamCard or TeamFaces subscribes for its team, and is told whenever that team's kept read is dropped
// (a successful team or membership write, or clearTeamCache), so it can forget what it shows and read again when next needed.
const listeners = new Map<string, Set<() => void>>();

/** Call `fn` after the kept read of team `id` is dropped. Returns the function that stops it. */
export function onTeamChange(id: string, fn: () => void): () => void {
	let set = listeners.get(id);
	if (!set) listeners.set(id, (set = new Set()));
	set.add(fn);
	return () => {
		const s = listeners.get(id);
		s?.delete(fn);
		if (s && !s.size) listeners.delete(id);
	};
}

/** Drop the kept read of one team (or all) and tell whoever shows it. The read is gone before they are told, so a refetch is fresh. */
export function clearTeamCache(id?: string): void {
	const ids = id === undefined ? [...listeners.keys()] : [id];
	if (id === undefined) cache.clear();
	else cache.delete(id);
	for (const key of ids) for (const fn of [...(listeners.get(key) ?? [])]) fn();
}
