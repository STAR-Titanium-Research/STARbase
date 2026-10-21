// Marking a Conform run done (spec "Panels"): a run with a log linked but no run window is allowed, with a warning. The
// summary, energy and steps are all worked out over the window, so a run done without one has none of them. Pure; the read is
// one request for the card's operations.

import type { Check, HostApi } from '@d1/ui';

export const CONFORM_WINDOW_NOT_SET = 'Conform run window not set';

/** The part of `conform_run_data` the check reads. */
export interface ConformRunState {
	operation_id: string;
	log_id: string | null;
	window_start: string | null;
	window_end: string | null;
}

/** A warning for each run that has a log and no (complete) window. A run with no log is another matter (nothing to window) and says nothing. */
export function conformWindowChecks(runs: readonly ConformRunState[]): Check[] {
	return runs
		.filter((r) => !!r.log_id && (!r.window_start || !r.window_end))
		.map((r) => ({ key: r.operation_id, level: 'warn' as const, text: CONFORM_WINDOW_NOT_SET }));
}

/** The run rows of these operations; a read that fails (a role with no access to the table) is no answer, so no warning. */
export async function readConformRuns(api: Pick<HostApi, 'get'>, operationIds: readonly string[]): Promise<ConformRunState[]> {
	if (!operationIds.length) return [];
	try {
		const res = await api.get('/items/conform_run_data', {
			params: { filter: { operation_id: { _in: [...operationIds] } }, fields: ['operation_id', 'log_id', 'window_start', 'window_end'], limit: -1 },
		});
		const rows = res.data?.data;
		return Array.isArray(rows) ? (rows as ConformRunState[]) : [];
	} catch {
		return [];
	}
}
