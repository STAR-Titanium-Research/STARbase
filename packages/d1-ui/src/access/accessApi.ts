// The calls of the "Who has access" dialog: the d1-record-access endpoint (core/extensions/d1-record-access) and the People
// search. Every call returns plain data or the endpoint's own message; nothing throws, so the dialog shows the text it is given.
//
// The endpoint answers with the bare JSON (no `data` wrapper), /items answers with `{ data: [...] }`.
import type { ExplorerHost } from '../host';
import { errorText } from '../format';
import { peopleSearchQuery, type AccessEntry, type AccessList, type BlockedBy, type PersonHit } from './accessModel';

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
