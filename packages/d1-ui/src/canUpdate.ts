// Pure parts of useCanUpdate: the URL of Directus 11's item-permissions endpoint and how to read
// its answer. Row-level visibility (ADR-0011) means a user can read a record they may not edit
// (an investigator, someone who only sees it through a campaign...), so a page asks before it
// offers Edit.

// `GET /permissions/me/:collection/:pk` answers `{ data: ItemPermissions }` (@directus/types):
// `update.access` is true when the signed-in user's update permission covers this very row.
export function itemPermissionsUrl(collection: string, id: string): string {
	return `/permissions/me/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
}

// true / false when the answer says so; null when it does not (unknown). Callers show the Edit
// button unless this is exactly false: the server enforces the rule anyway, so a failed or odd
// answer must not take Edit away from someone who may use it.
export function updateAccess(body: unknown): boolean | null {
	const access = (body as any)?.data?.update?.access;
	return typeof access === 'boolean' ? access : null;
}

// Messages for a refused write (HTTP 403 / FORBIDDEN) on a record the user may read but not change.
export const NOT_OWNER_MESSAGE = 'Only the owner or a co-owner can change this record.';
export const NOT_YOUR_RECORD_MESSAGE = 'You can only add records you own or co-own.';

export const NOT_CAMPAIGN_OWNER_MESSAGE = "Only the campaign's owner can change it.";
export const NOT_PI_MESSAGE = "Only the project's PI can change it.";

// The refusal text for a record of `collection` when the server gave no reason of its own: campaigns
// have no co-owners and projects are the PI's; samples, operations and tests are the owner's or a
// co-owner's. Anything else gets the generic owner text.
export function notOwnerMessage(collection?: string | null): string {
	if (collection === 'campaigns') return NOT_CAMPAIGN_OWNER_MESSAGE;
	if (collection === 'projects') return NOT_PI_MESSAGE;
	return NOT_OWNER_MESSAGE;
}

// The d1-access-guard marks the 403s it throws (`extensions.source`) and describes them in fields:
// `kind` 'owner' (changing who owns a record) or 'junction' (adding a row that would grant read or edit
// of a record the user may not change), `collection`, `parent` (the record the user may not change)
// and `id`. Directus's own 403 also has `extensions.reason` ("You don't have permission to perform
// "update" for collection ... or it does not exist."), so a reason alone says nothing about who
// threw it: only a marked error is the guard's.
export const GUARD_SOURCE = 'd1-access-guard';

export interface GuardRefusal {
	kind: string;
	collection?: string;
	parent?: string;
	reason?: string;
}

// The guard's refusal in a failed request, or null for any other error (a stock Directus 403, a 500...).
export function guardRefusal(e: any): GuardRefusal | null {
	const list: any[] = e?.response?.data?.errors ?? [];
	for (const x of list) {
		const ext = x?.extensions;
		if (ext?.source !== GUARD_SOURCE) continue;
		const reason = typeof ext.reason === 'string' && ext.reason.trim() ? ext.reason.trim() : undefined;
		return { kind: String(ext.kind ?? ''), collection: ext.collection, parent: ext.parent, reason };
	}
	return null;
}

const OWNER_NOUN: Record<string, string> = {
	physical_samples: 'sample',
	manufacturing_operations: 'operation',
	test_sessions: 'test',
};
const PARENT_SENTENCE: Record<string, string> = {
	physical_samples: 'You can only add this to a sample you own or co-own.',
	campaigns: "Only the campaign's owner can add samples to it.",
	projects: "Only the project's principal investigator can add investigators to it.",
	test_sessions: 'You can only change the samples of a test you own, or of a test on a sample you own or co-own.',
};

// The sentence for a guard refusal: by kind and collection, else the guard's own plain-words reason.
export function guardMessage(g: GuardRefusal): string | null {
	if (g.kind === 'owner' && g.collection && OWNER_NOUN[g.collection]) {
		return `Only the ${OWNER_NOUN[g.collection]}'s owner can hand it to someone else.`;
	}
	if (g.kind === 'junction' && g.parent && PARENT_SENTENCE[g.parent]) return PARENT_SENTENCE[g.parent];
	return g.reason ?? null;
}

// Why the d1-access-guard refused a write, as one sentence; null when the error is not the guard's (the
// caller then falls back to notOwnerMessage(collection)).
export function forbiddenReason(e: any): string | null {
	const g = guardRefusal(e);
	return g ? guardMessage(g) : null;
}
