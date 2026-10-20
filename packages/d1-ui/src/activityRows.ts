import { DEFAULT_WEEKS, windowStart, type ActivityWindow } from './activity';
import { anyProjectFilter, effectiveProjectId, effectiveProjectIdFields, projectScopeFilter } from './projectScope';

// Reads the dates of the operations and tests inside the sparkline window, for one project or for
// every project at once. Why a capped client fetch and not `aggregate` + `groupBy`: see the top of
// activity.ts (TIMESTAMPTZ columns, and SQL year()/week() disagree at the turn of the year). Only
// a few small columns come back per row, newest first, so a cap of ACTIVITY_ROW_CAP per collection
// covers a very busy lab (26 weeks x ~190 a week). Past the cap the oldest rows are the ones
// missing, and `truncated` lets the page say so.
//
// Only DONE work counts (`work_state` = done; planned work is read separately, per planned date).
//
// A row belongs to a project by the kit-wide rule (projectScope.ts): its own project_id, else its
// campaign's. That is why, across all projects, the campaign's project is read too, and why the row's
// `project_id` in the result is the effective one. For one project every row is that project's by the
// filter, so only the date is read and `project_id` is the one asked for.

export const ACTIVITY_ROW_CAP = 5000;

type GetItems = (collection: string, params?: Record<string, unknown>) => Promise<any[]>;

export interface ActivityRows {
	ops: { project_id: string; operation_date: string }[];
	tests: { project_id: string; session_date: string }[];
	truncated: boolean;
	/** The collections whose read failed while the other answered (a role that may read tests but not operations). Both failing throws instead. */
	failed: { collection: 'operations' | 'tests'; error: unknown }[];
}

export async function fetchActivityRows(
	getItems: GetItems,
	projectId?: string,
	span: ActivityWindow = DEFAULT_WEEKS,
	now: Date = new Date(),
): Promise<ActivityRows> {
	// "All" reads every dated row (newest first, up to the cap), so the oldest ones are what a busy project loses.
	const inWindow = (dateField: string) =>
		span === 'all' ? { [dateField]: { _nnull: true } } : { [dateField]: { _gte: windowStart(span, now) } };
	const scope = projectId ? projectScopeFilter(projectId) : anyProjectFilter();
	const read = async (collection: string, dateField: string) => {
		const rows = await getItems(collection, {
			filter: { _and: [scope, inWindow(dateField), { work_state: { _eq: 'done' } }] },
			fields: projectId ? [dateField] : [...effectiveProjectIdFields, dateField],
			sort: [`-${dateField}`],
			limit: ACTIVITY_ROW_CAP,
		});
		return { rows, capped: rows.length >= ACTIVITY_ROW_CAP };
	};
	// One collection failing (a role that cannot read it) keeps the other's series; both failing is an error.
	const [opsRes, testsRes] = await Promise.allSettled([read('manufacturing_operations', 'operation_date'), read('test_sessions', 'session_date')]);
	if (opsRes.status === 'rejected' && testsRes.status === 'rejected') throw opsRes.reason;
	const none = { rows: [] as any[], capped: false };
	const ops = opsRes.status === 'fulfilled' ? opsRes.value : none;
	const tests = testsRes.status === 'fulfilled' ? testsRes.value : none;
	const failed: ActivityRows['failed'] = [];
	if (opsRes.status === 'rejected') failed.push({ collection: 'operations', error: opsRes.reason });
	if (testsRes.status === 'rejected') failed.push({ collection: 'tests', error: testsRes.reason });
	// A capped series is known only back to its oldest row (it reads newest first). For "All" the chart starts at
	// the later of the capped series' oldest dates, so no week before that shows a false zero for either series.
	let from = 0;
	if (span === 'all') {
		for (const [series, dateField] of [[ops, 'operation_date'], [tests, 'session_date']] as const) {
			if (!series.capped) continue;
			const oldest = Math.min(...series.rows.map((r) => new Date(r[dateField]).getTime()).filter((t) => !Number.isNaN(t)));
			if (Number.isFinite(oldest)) from = Math.max(from, oldest);
		}
	}
	const flat = (rows: any[], dateField: string) =>
		rows
			.filter((r) => !from || !(new Date(r[dateField]).getTime() < from))
			.map((r) => ({ project_id: (projectId ?? effectiveProjectId(r)) as string, [dateField]: r[dateField] }));
	return {
		ops: flat(ops.rows, 'operation_date') as ActivityRows['ops'],
		tests: flat(tests.rows, 'session_date') as ActivityRows['tests'],
		truncated: ops.capped || tests.capped,
		failed,
	};
}
