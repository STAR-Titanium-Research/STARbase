// The People page's list state: what the URL says (chip, role, sort, search, attention filter, open person), and the pure
// filter/sort/count functions over the rows the page loaded (peopleApi.ts). No Vue, no network, so it is all unit-tested.

/** The login a person has, as d1-people-admin returns it (null for a person without one). */
export interface PeopleLogin {
	status: string | null;
	role_id: string | null;
	role_name: string | null;
	last_access: string | null;
	email: string | null;
}

/**
 * One row of the list. `kind: 'person'` is a person (an administrator's row is the endpoint's `Person`; a member's is a /items/people
 * row with `login: null` and `attention: []`). `kind: 'login'` is a login that has no person: person_id is null and the row stands in
 * for the login, with attention ['login_without_person'].
 */
export interface PeopleRow {
	kind: 'person' | 'login';
	person_id: string | null;
	full_name: string;
	email: string | null;
	is_researcher: boolean;
	is_operator: boolean;
	active: boolean;
	notes: string | null;
	user_id: string | null;
	login: PeopleLogin | null;
	attention: string[];
	/** When the person was added. The People endpoint does not return it yet, so "Recently added" leaves rows without it last. */
	created_at?: string | null;
}

export type Chip = 'all' | 'researchers' | 'operators' | 'nologin' | 'former';
export type RoleFilter = 'any' | 'none' | string; // 'any', 'none' (persons with no login) or a role id
export type SortKey = 'name' | 'last' | 'added';
export interface ListState {
	chip: Chip;
	role: RoleFilter;
	sort: SortKey;
	q: string;
	attn: string | null;
	person: string | null;
}

const CHIPS: readonly Chip[] = ['all', 'researchers', 'operators', 'nologin', 'former'];
const SORTS: readonly SortKey[] = ['name', 'last', 'added'];

// vue-router gives a repeated key as an array: the first value wins.
const text = (v: unknown): string => {
	const one = Array.isArray(v) ? v[0] : v;
	return typeof one === 'string' ? one : '';
};

/** The list state a URL query describes; anything unknown or empty is the default. */
export function parseListState(query: Record<string, unknown>): ListState {
	const chip = text(query.f);
	const sort = text(query.sort);
	return {
		chip: (CHIPS as readonly string[]).includes(chip) ? (chip as Chip) : 'all',
		role: text(query.role) || 'any',
		sort: (SORTS as readonly string[]).includes(sort) ? (sort as SortKey) : 'name',
		q: text(query.q),
		attn: text(query.attn) || null,
		person: text(query.person) || null,
	};
}

/** The URL query for a list state; defaults are left out, so the default state is {}. */
export function toQuery(s: ListState): Record<string, string> {
	const out: Record<string, string> = {};
	if (s.chip !== 'all') out.f = s.chip;
	if (s.role !== 'any') out.role = s.role;
	if (s.sort !== 'name') out.sort = s.sort;
	if (s.q) out.q = s.q;
	if (s.attn) out.attn = s.attn;
	if (s.person) out.person = s.person;
	return out;
}

const chipMatches: Record<Chip, (r: PeopleRow) => boolean> = {
	all: () => true,
	researchers: (r) => r.is_researcher,
	operators: (r) => r.is_operator,
	nologin: (r) => r.login === null,
	former: (r) => !r.active,
};

function roleMatches(r: PeopleRow, role: RoleFilter): boolean {
	if (role === 'any') return true;
	if (role === 'none') return r.login === null;
	return r.login?.role_id === role;
}

const when = (iso: string | null | undefined): number => {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isNaN(t) ? -Infinity : t;
};
const byName = (a: PeopleRow, b: PeopleRow) =>
	a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' }) || (a.person_id ?? a.user_id ?? '').localeCompare(b.person_id ?? b.user_id ?? '');
// Newest first; a row without a date goes last (-Infinity), then by name.
const byDateDesc = (date: (r: PeopleRow) => number) => (a: PeopleRow, b: PeopleRow) => {
	const x = date(a);
	const y = date(b);
	return x === y ? byName(a, b) : x === -Infinity ? 1 : y === -Infinity ? -1 : y - x;
};
const SORTERS: Record<SortKey, (a: PeopleRow, b: PeopleRow) => number> = {
	name: byName,
	last: byDateDesc((r) => when(r.login?.last_access)),
	added: byDateDesc((r) => when(r.created_at)),
};

/**
 * The rows to show. A login without a person is a row only under the "All" chip or the "login without person" attention filter;
 * every chip counts persons. A new array: the input is not changed.
 */
export function applyList(rows: PeopleRow[], s: ListState): PeopleRow[] {
	const q = s.q.trim().toLowerCase();
	return rows
		.filter((r) => {
			if (r.kind === 'login') {
				if (s.attn !== 'login_without_person' && !(s.chip === 'all' && s.attn === null)) return false;
			} else if (!chipMatches[s.chip](r)) return false;
			if (!roleMatches(r, s.role)) return false;
			if (s.attn && !r.attention.includes(s.attn)) return false;
			if (q && !`${r.full_name}\n${r.email ?? ''}\n${r.login?.email ?? ''}`.toLowerCase().includes(q)) return false;
			return true;
		})
		.sort(SORTERS[s.sort]);
}

/** How many persons each chip holds (login rows are not counted). */
export function chipCounts(rows: PeopleRow[]): Record<Chip, number> {
	const counts: Record<Chip, number> = { all: 0, researchers: 0, operators: 0, nologin: 0, former: 0 };
	for (const r of rows) {
		if (r.kind !== 'person') continue;
		for (const chip of CHIPS) if (chipMatches[chip](r)) counts[chip] += 1;
	}
	return counts;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The "Needs attention" wording for each d1_private.people_attention() key (CONTEXT.md terms: login, person, Former, Suspended). */
export const ATTENTION_LABELS: Record<string, (n: number) => string> = {
	login_without_person: (n) => `${plural(n, 'login', 'logins')} with no person`,
	invite_not_accepted: (n) => `${plural(n, 'invite', 'invites')} not accepted`,
	missing_email: (n) => `${plural(n, 'person', 'people')} missing an email`,
	possible_duplicate: (n) => plural(n, 'possible duplicate', 'possible duplicates'),
	former_login_active: (n) => `${n} Former ${n === 1 ? 'person whose login is' : 'people whose logins are'} still active`,
	suspended_owns_records: (n) => `${n} Suspended ${n === 1 ? 'login that still owns' : 'logins that still own'} records`,
};
