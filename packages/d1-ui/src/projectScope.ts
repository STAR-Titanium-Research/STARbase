// The one rule for "this record belongs to project P".
//
// Nothing in the database copies a campaign's project onto its operations, tests or samples (only
// the `d1-project-inherit` form interface and, since the pickers set it, the campaign panels do),
// so a record's own `project_id` can be null while its campaign is in project P. The rule, shared
// with v_project_rollup (migration 20261002000116, COALESCE(o.project_id, c.project_id)):
//
//   effective project = record.project_id, else record.campaign_id.project_id
//
// Every project-scoped read of operations and tests (and the Project page's samples) uses these
// builders instead of a bare `project_id = P`, so tiles, sparklines, equipment use and the cards of
// a campaign cannot disagree about what is "in" the project.
//
// Known limit: a record with its own project_id = Q inside a campaign of project P is Q's by this
// rule, but P's campaign card counts it (cards filter on the campaign alone).

export const effectiveProjectIdFields = ['project_id', 'campaign_id.project_id'];

// Rows of manufacturing_operations / test_sessions that belong to project `projectId`: their own
// project_id, or, with none, the project of their campaign.
export function projectScopeFilter(projectId: string | number) {
	return {
		_or: [
			{ project_id: { _eq: projectId } },
			{ _and: [{ project_id: { _null: true } }, { campaign_id: { project_id: { _eq: projectId } } }] },
		],
	};
}

// Rows that belong to any project, by the same rule (one read feeding many projects).
export function anyProjectFilter() {
	return {
		_or: [{ project_id: { _nnull: true } }, { campaign_id: { project_id: { _nnull: true } } }],
	};
}

// physical_samples are in campaigns through the campaign_samples junction (alias `campaigns`), not
// a campaign_id column: a sample belongs to project P by its own project_id or by being in one of
// P's campaigns.
export function sampleProjectScopeFilter(projectId: string | number) {
	return {
		_or: [
			{ project_id: { _eq: projectId } },
			{ campaigns: { _some: { campaign_id: { project_id: { _eq: projectId } } } } },
		],
	};
}

type MaybeProject = string | { project_id?: string | null } | null | undefined;
const idOf = (v: MaybeProject): string | null => (v && typeof v === 'object' ? v.project_id : v) || null;

// The project a row read with `effectiveProjectIdFields` belongs to, or null.
export function effectiveProjectId(row: {
	project_id?: MaybeProject;
	campaign_id?: { project_id?: MaybeProject } | string | null;
}): string | null {
	const own = idOf(row?.project_id);
	if (own) return own;
	const campaign = row?.campaign_id;
	return campaign && typeof campaign === 'object' ? idOf(campaign.project_id) : null;
}
