// The Inbox's counts as the sidebar badge, the Home panel and the page header show them: what GET /d1-inbox/summary answers (spec
// 2026-10-15-found-files-inbox-design.md section 9), read without ever throwing, and the words for them. Plain functions (no Vue, no
// network) so they are tested on their own; useInboxSummary.ts is the shared poller over them.

/** The two counts of one Inbox: files found since the first scan ("new"), and older files (the backlog) that name exactly one record. */
export interface InboxCounts {
	new: number;
	older_matches: number;
}

export interface InboxSummary {
	/** The caller's own folder; null when they have no People row. `has_alias` is false until an administrator sets their uni alias. */
	person: (InboxCounts & { has_alias: boolean }) | null;
	/** One entry per team the caller is an active member of and that has a share folder. */
	teams: Array<InboxCounts & { team_id: string; name: string }>;
	/** Over the person and the teams. The answer may carry its own totals (`new`, `older_matches`); they are summed when it does not. */
	newCount: number;
	olderMatches: number;
}

const count = (v: unknown): number => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/** The summary out of the endpoint's answer (bare, or wrapped as `{ data }`), or null when it is not an object at all. */
export function parseSummary(body: unknown): InboxSummary | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	const raw = body as Record<string, any>;
	const wrapped = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) && !('person' in raw) && !('teams' in raw);
	const b: Record<string, any> = wrapped ? raw.data : raw;
	const p = b.person && typeof b.person === 'object' ? b.person : null;
	const person = p ? { new: count(p.new), older_matches: count(p.older_matches), has_alias: p.has_alias !== false } : null;
	const teams = (Array.isArray(b.teams) ? b.teams : [])
		.filter((t: any) => t && typeof t.team_id === 'string')
		.map((t: any) => ({ team_id: t.team_id as string, name: typeof t.name === 'string' ? t.name : '', new: count(t.new), older_matches: count(t.older_matches) }));
	const sum = (pick: (c: InboxCounts) => number) => (person ? pick(person) : 0) + teams.reduce((n: number, t: InboxCounts) => n + pick(t), 0);
	return {
		person,
		teams,
		newCount: isCount(b.new) ? count(b.new) : sum((c) => c.new),
		olderMatches: isCount(b.older_matches) ? count(b.older_matches) : sum((c) => c.older_matches),
	};
}

/** The sidebar badge: nothing for none, the number up to 99, then "99+". */
export const badgeText = (n: number): string => (n <= 0 ? '' : n > 99 ? '99+' : String(n));

/** "1 new file" / "12 new files". */
export const newFilesText = (n: number): string => `${n} new file${n === 1 ? '' : 's'}`;

/** "1 older file matches a record" / "3 older files match a record". */
export const olderFilesText = (n: number): string => `${n} older file${n === 1 ? '' : 's'} ${n === 1 ? 'matches' : 'match'} a record`;

/** The sidebar row's accessible label: "Inbox, 3 new files". */
export const inboxLabel = (newCount: number): string => (newCount > 0 ? `Inbox, ${newFilesText(newCount)}` : 'Inbox');

/** Where the Home panel sends you: the Inbox, on the Older files tab only when nothing is new and older files match a record. */
export const inboxTarget = (s: Pick<InboxSummary, 'newCount' | 'olderMatches'> | null): string =>
	s && s.newCount === 0 && s.olderMatches > 0 ? '/inbox?tab=older' : '/inbox';
