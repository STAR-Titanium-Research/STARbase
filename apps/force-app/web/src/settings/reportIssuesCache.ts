// The "Recently reported" list, cached at module level (#89) and reconciled with what was just
// filed (#88).
//
// #89: SettingsPage mounts ReportBugSettings under v-if, so every visit to the tab remounted it and
// refetched the list from GitHub. The list now outlives the component, and a visit only refetches
// when it is older than STALE_MS (the refresh button always does).
//
// #88: GitHub's issue list lags a freshly created issue by a few seconds, so the refetch straight
// after filing came back without it and the new row never appeared. The filed issue is added
// right away from the create response, kept until a fetched list contains it, and then merged
// with the fetched list by issue number so it can't vanish in between.
import { ref } from 'vue';

export interface IssueRow {
	number: number;
	title: string;
	url: string;
	state: string;
	labels?: string[];
	created_at?: string;
}

export const STALE_MS = 60_000;
/** An optimistic row nothing has confirmed after this long is dropped (deleted, or never landed). */
export const PENDING_MAX_MS = 10 * 60_000;
/** When to re-read the list after filing, to let GitHub's listing catch up. */
export const REFETCH_AFTER_FILING_MS = 3000;

export const cachedIssues = ref<IssueRow[]>([]);
export const cachedAt = ref(0);
// Issues filed from this app that no fetched list has confirmed yet, keyed by number.
const pending = new Map<number, { row: IssueRow; at: number }>();

export function isStale(now: number = Date.now(), at: number = cachedAt.value): boolean {
	return !at || now - at > STALE_MS;
}

/** The row to show for a just-filed issue, from the relay's create response; null when the
 *  response lacks what is needed to link to it. */
export function optimisticRow(resp: { number?: unknown; url?: unknown; title?: unknown; labels?: unknown }, fallbackTitle = ''): IssueRow | null {
	const number = Number(resp.number);
	if (!Number.isInteger(number) || number <= 0 || typeof resp.url !== 'string' || !resp.url) return null;
	return {
		number,
		title: typeof resp.title === 'string' && resp.title ? resp.title : fallbackTitle,
		url: resp.url,
		state: 'open',
		labels: Array.isArray(resp.labels) ? resp.labels.filter((l): l is string => typeof l === 'string') : [],
	};
}

/** Fetched list + still-unconfirmed optimistic rows, newest first, one row per number (the
 *  fetched row wins). Pure: `pendingRows` is passed in. */
export function mergeIssues(fetched: IssueRow[], pendingRows: IssueRow[]): IssueRow[] {
	const byNumber = new Map<number, IssueRow>();
	for (const r of pendingRows) byNumber.set(r.number, r);
	for (const r of fetched) byNumber.set(r.number, r);
	return [...byNumber.values()].sort((a, b) => b.number - a.number);
}

/** Show a just-filed issue immediately. */
export function addOptimistic(row: IssueRow, now: number = Date.now()): void {
	pending.set(row.number, { row, at: now });
	cachedIssues.value = mergeIssues(cachedIssues.value, [row]);
}

/** Store a freshly fetched list: confirmed optimistic rows are retired, unconfirmed ones kept. */
export function applyFetched(fetched: IssueRow[], now: number = Date.now()): void {
	const seen = new Set(fetched.map((r) => r.number));
	for (const [n, p] of pending) {
		if (seen.has(n) || now - p.at > PENDING_MAX_MS) pending.delete(n);
	}
	cachedIssues.value = mergeIssues(fetched, [...pending.values()].map((p) => p.row));
	cachedAt.value = now;
}

/** Test helper. */
export function resetIssuesCache(): void {
	pending.clear();
	cachedIssues.value = [];
	cachedAt.value = 0;
}
