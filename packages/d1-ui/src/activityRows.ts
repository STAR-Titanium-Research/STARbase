import { DEFAULT_WEEKS, windowStart } from './activity';
import { anyProjectFilter, effectiveProjectId, effectiveProjectIdFields, projectScopeFilter } from './projectScope';

// Reads the dates of the operations and tests inside the sparkline window, for one project or for
// every project at once. Why a capped client fetch and not `aggregate` + `groupBy`: see the top of
// activity.ts (TIMESTAMPTZ columns, and SQL year()/week() disagree at the turn of the year). Only
// a few small columns come back per row, newest first, so a cap of ACTIVITY_ROW_CAP per collection
// covers a very busy lab (26 weeks x ~190 a week). Past the cap the oldest rows are the ones
// missing, and `truncated` lets the page say so.
//
// A row belongs to a project by the kit-wide rule (projectScope.ts): its own project_id, else its
// campaign's. That is why the campaign's project is read too, and why the row's `project_id` in the
// result is the effective one.

export const ACTIVITY_ROW_CAP = 5000;

type GetItems = (collection: string, params?: Record<string, unknown>) => Promise<any[]>;

export interface ActivityRows {
	ops: { project_id: string; operation_date: string }[];
	tests: { project_id: string; session_date: string }[];
	truncated: boolean;
}

export async function fetchActivityRows(
	getItems: GetItems,
	projectId?: string,
	weeks: number = DEFAULT_WEEKS,
	now: Date = new Date(),
): Promise<ActivityRows> {
	const since = windowStart(weeks, now);
	const scope = projectId ? projectScopeFilter(projectId) : anyProjectFilter();
	const read = async (collection: string, dateField: string) => {
		const rows = await getItems(collection, {
			filter: { _and: [scope, { [dateField]: { _gte: since } }] },
			fields: [...effectiveProjectIdFields, dateField],
			sort: [`-${dateField}`],
			limit: ACTIVITY_ROW_CAP,
		});
		return { rows, capped: rows.length >= ACTIVITY_ROW_CAP };
	};
	const [ops, tests] = await Promise.all([read('manufacturing_operations', 'operation_date'), read('test_sessions', 'session_date')]);
	const flat = (rows: any[], dateField: string) =>
		rows.map((r) => ({ project_id: effectiveProjectId(r) as string, [dateField]: r[dateField] }));
	return {
		ops: flat(ops.rows, 'operation_date') as ActivityRows['ops'],
		tests: flat(tests.rows, 'session_date') as ActivityRows['tests'],
		truncated: ops.capped || tests.capped,
	};
}
