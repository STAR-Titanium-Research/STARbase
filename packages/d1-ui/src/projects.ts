// Pure logic of the Projects index and the Project page: who has which role on a project, the
// index's filters and search, and the per-campaign counts and progress. No network, no Vue.
//
// Involvement columns are those of ADR-0011: the PI is `principal_investigator_person` (a people
// row whose `user_id` is the login), investigators are the M2M alias `secondary_investigators`
// whose `user_id` is a directus_users id. Nothing here reads the hidden legacy columns.

import { analysisState, countsTowardForceProgress } from './campaign/rollup';
import { operationCategoryFor } from './campaign/campaignType';

export type ProjectRole = 'pi' | 'investigator';
// 'all' = every project the user can read; 'any' = projects where the user is PI or investigator.
export type RoleFilter = 'all' | 'any' | ProjectRole;
export type StatusFilter = 'all' | 'active' | 'inactive';

export interface ProjectRow {
	project_id: string;
	project_code: string;
	project_name: string;
	is_active?: boolean | null;
	principal_investigator_person?: { person_id?: string; full_name?: string; user_id?: string | null } | null;
	// `user_id` is a bare id when only the id was requested, or an expanded user.
	secondary_investigators?: Array<{ user_id?: string | { id?: string } | null }> | null;
}

const userIdOf = (v: string | { id?: string } | null | undefined): string | null =>
	v && typeof v === 'object' ? (v.id ?? null) : (v ?? null);

// The signed-in user's role on a project. The PI wins when someone is both.
export function projectRole(project: ProjectRow, userId: string | null | undefined): ProjectRole | null {
	if (!userId) return null;
	if (project.principal_investigator_person?.user_id === userId) return 'pi';
	const isInvestigator = (project.secondary_investigators ?? []).some((i) => userIdOf(i?.user_id) === userId);
	return isInvestigator ? 'investigator' : null;
}

export const projectStatusLabel = (isActive: boolean | null | undefined): string =>
	isActive === false ? 'Inactive' : 'Active';

export interface ProjectFilters {
	role: RoleFilter;
	status: StatusFilter;
	query: string;
}

// Roles other than 'all' need the user's id.
// The search is a case-insensitive substring of the code or the name; blank matches everything.
export function filterProjects<T extends ProjectRow>(
	projects: ReadonlyArray<T>,
	filters: ProjectFilters,
	userId: string | null | undefined,
): T[] {
	const q = filters.query.trim().toLowerCase();
	return projects.filter((p) => {
		if (filters.role !== 'all') {
			const role = projectRole(p, userId);
			if (filters.role === 'any' ? role === null : role !== filters.role) return false;
		}
		if (filters.status === 'active' && p.is_active === false) return false;
		if (filters.status === 'inactive' && p.is_active !== false) return false;
		if (q && !`${p.project_code} ${p.project_name}`.toLowerCase().includes(q)) return false;
		return true;
	});
}

// ── Per-campaign counts and progress ────────────────────────────────────────────────────────────

export interface CampaignLite {
	campaign_id: string;
	campaign_type?: string | null;
}
export interface OpLite {
	operation_id: string;
	campaign_id?: string | null;
	process_category?: string | null;
}
export interface AnalysisLite {
	operation_id: string;
	status?: string | null;
}

/**
 * The progress bar of a campaign card. `unavailable` is shown instead of a bar that would be wrong:
 * `truncated` when a capped row read hit its cap, `forbidden` when the role cannot read the data.
 * `none` for a campaign type with no bar (imaging / analysis).
 */
export type ProgressState =
	| { kind: 'bar'; label: string; done: number; total: number }
	| { kind: 'unavailable'; label: string; reason: 'truncated' | 'forbidden' }
	| { kind: 'none' };

export interface CampaignProgress {
	campaign_id: string;
	samples: number;
	operations: number;
	tests: number;
	/** The progress bar: what "done" means depends on the campaign type. */
	progress: ProgressState;
}

/** Row reads behind the machining "force analysed" bar. Null when they could not be read at all. */
export interface ForceRows {
	operations: ReadonlyArray<OpLite>;
	analyses: ReadonlyArray<AnalysisLite>;
	/** A read hit its row cap, so the rows are not the full set. */
	truncated: boolean;
}

// The counts are exact (`aggregate[count]` grouped by campaign) and passed in as maps; only the
// force-analysis states need rows. Machining trials show "force analysed n / m" over their
// machining operations (an operation whose files were all skipped is left out, otherwise the bar
// could never fill); testing campaigns show "tests complete n / m"; other types have no bar. The
// type decides through operationCategoryFor(), the same mapping the campaign pickers use.
export function campaignProgress(input: {
	campaigns: ReadonlyArray<CampaignLite>;
	samplesByCampaign: ReadonlyMap<string, number>;
	operationsByCampaign: ReadonlyMap<string, number>;
	testsByCampaign: ReadonlyMap<string, number>;
	/** Tests in a done status per campaign; null when that read failed. */
	testsDoneByCampaign: ReadonlyMap<string, number> | null;
	forceRows: ForceRows | null;
}): Map<string, CampaignProgress> {
	const analysesByOp = new Map<string, AnalysisLite[]>();
	const opsByCampaign = new Map<string, OpLite[]>();
	if (input.forceRows) {
		for (const a of input.forceRows.analyses) {
			const list = analysesByOp.get(a.operation_id);
			if (list) list.push(a);
			else analysesByOp.set(a.operation_id, [a]);
		}
		for (const o of input.forceRows.operations) {
			if (!o.campaign_id) continue;
			const list = opsByCampaign.get(o.campaign_id);
			if (list) list.push(o);
			else opsByCampaign.set(o.campaign_id, [o]);
		}
	}
	const out = new Map<string, CampaignProgress>();
	for (const c of input.campaigns) {
		const tests = input.testsByCampaign.get(c.campaign_id) ?? 0;
		let progress: ProgressState = { kind: 'none' };
		if (c.campaign_type === 'testing_campaign') {
			const label = 'Tests complete';
			progress = input.testsDoneByCampaign
				? { kind: 'bar', label, done: input.testsDoneByCampaign.get(c.campaign_id) ?? 0, total: tests }
				: { kind: 'unavailable', label, reason: 'forbidden' };
		} else if (operationCategoryFor(c.campaign_type) === 'machining') {
			const label = 'Force analysed';
			const force = input.forceRows;
			if (!force) progress = { kind: 'unavailable', label, reason: 'forbidden' };
			else if (force.truncated) progress = { kind: 'unavailable', label, reason: 'truncated' };
			else {
				const states = (opsByCampaign.get(c.campaign_id) ?? []).map((o) => ({
					o,
					state: analysisState(analysesByOp.get(o.operation_id) ?? []),
				}));
				const counted = states.filter(({ o, state }) => countsTowardForceProgress(o, state));
				progress = { kind: 'bar', label, done: counted.filter((x) => x.state === 'done').length, total: counted.length };
			}
		}
		out.set(c.campaign_id, {
			campaign_id: c.campaign_id,
			samples: input.samplesByCampaign.get(c.campaign_id) ?? 0,
			operations: input.operationsByCampaign.get(c.campaign_id) ?? 0,
			tests,
			progress,
		});
	}
	return out;
}

// Rows of `aggregate[count]=*&groupBy[]=<key>` as a Map. Directus returns the count as a string
// for Postgres bigint, so it is coerced; a group with no key (null) is dropped.
export function countsByKey(rows: ReadonlyArray<Record<string, unknown>>, key: string): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of rows) {
		const k = r[key];
		if (k === null || k === undefined || k === '') continue;
		const n = Number(r.count);
		out.set(String(k), Number.isFinite(n) ? n : 0);
	}
	return out;
}
