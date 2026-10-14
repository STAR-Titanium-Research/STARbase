import type { AnalysisLink } from '@d1/ui';

// Pure helpers of Home's "Recent activity" rail (home/RecentActivity.vue): the shape of one feed item,
// merging the three sources into one newest-first list, and the two short strings a rail item shows.
// No Vue and no host here, so they are tested on their own (activity.test.ts).

export type ActivityKind = 'sample' | 'operation' | 'fast' | 'test';

export interface Activity {
	kind: ActivityKind;
	id: string;
	code: string;
	meta: string;
	date: string;
	to: string;
	extra?: AnalysisLink | null;
	/** The code is a description (an operation without a pass code), so it is not set in monospace. */
	plain?: boolean;
}

export const KIND_LABEL: Record<ActivityKind, string> = { sample: 'Sample', operation: 'Operation', fast: 'FAST', test: 'Test' };
export const KIND_ICON: Record<ActivityKind, string> = { sample: 'science', operation: 'precision_manufacturing', fast: 'bolt', test: 'fact_check' };

/** How many items the rail shows (it scrolls, so more than the table's nine). */
export const RAIL_LIMIT = 15;

const timeOf = (iso: string): number => new Date(iso).getTime();

/**
 * One list from the sources that loaded: items without a readable date are dropped (they cannot be
 * placed), the rest are sorted newest first, ties keep their source order, and at most `limit` stay.
 */
export function mergeActivity(lists: Activity[][], limit: number = RAIL_LIMIT): Activity[] {
	return lists
		.flat()
		.map((a) => ({ a, t: a.date ? timeOf(a.date) : NaN }))
		.filter((x) => !Number.isNaN(x.t))
		.sort((x, y) => y.t - x.t)
		.slice(0, Math.max(0, limit))
		.map((x) => x.a);
}

/**
 * "just now", "5 min ago", "3 h ago", "2 d ago", "3 mo ago", "2 y ago"; '' when the time is missing or
 * unreadable. A time a little in the future (clock skew between the browser and the server) reads "just now".
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return '';
	const t = timeOf(iso);
	if (Number.isNaN(t)) return '';
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	const d = Math.floor(s / 86_400);
	if (d < 30) return `${d} d ago`;
	if (d < 365) return `${Math.floor(d / 30)} mo ago`;
	return `${Math.floor(d / 365)} y ago`;
}

/** The one-line detail under a rail item's code: "Sample · Steel 316L", or just "Operation" when there is nothing more. */
export function detailLine(a: Pick<Activity, 'kind' | 'meta'>): string {
	return a.meta && a.meta !== '—' ? `${KIND_LABEL[a.kind]} · ${a.meta}` : KIND_LABEL[a.kind];
}
