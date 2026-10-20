import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
	LIST_CAP, countsByKey, errorText, fetchActivityRows, isNotVisible, loadAccess, loadCampaignStats, plannedFromCounts,
	projectScopeFilter, sampleProjectScopeFilter, useExplorerHost, useItems, useRequestGate, useSections,
	type AccessList, type CampaignProgress, type PlannedInput, type SectionState,
} from '@d1/ui';

// Everything the Project page reads, as the signed-in user (so Directus permissions apply). Reads
// the real collections, not `project_rollup`, which ADR-0011 restricts. The project decides between
// "page" and "Not found or not visible to you"; every other block is a section that loads in
// parallel and fails on its own, so one forbidden collection does not blank the page.

const PROJECT_FIELDS = [
	'project_id', 'project_code', 'project_name', 'description', 'document_number', 'is_active',
	'start_date', 'end_date', 'export_controlled', 'version',
	'principal_investigator_person.person_id', 'principal_investigator_person.full_name',
	'principal_investigator_person.user_id',
];

// null: the role cannot read that collection (shown as a dash, never a wrong 0). Samples, operations and tests are the
// done ones (a sample that is not planned); `*Planned` are the planned ones.
export interface ProjectCounts {
	samples: number | null;
	operations: number | null;
	tests: number | null;
	campaigns: number | null;
	samplesPlanned: number | null;
	operationsPlanned: number | null;
	testsPlanned: number | null;
	/** Campaigns by status ("1 active · 1 planned"); empty when that read failed. */
	campaignStatuses: Record<string, number>;
}

const NO_COUNTS: ProjectCounts = {
	samples: null, operations: null, tests: null, campaigns: null,
	samplesPlanned: null, operationsPlanned: null, testsPlanned: null, campaignStatuses: {},
};

const sumOf = (groups: ReadonlyArray<Record<string, unknown>>): number => groups.reduce((total, g) => total + (Number(g.count) || 0), 0);

/** Dates of the done operations and tests over the project's whole history (the timeline picks its range from them). */
export interface Activity {
	ops: string[];
	tests: string[];
	/** The read hit its row cap: the oldest records are missing. */
	truncated: boolean;
	/** One of the two reads failed while the other answered: a sentence for the page, '' when both worked. */
	partialError: string;
}

export interface PlannedWork {
	ops: PlannedInput[];
	tests: PlannedInput[];
}

export interface EquipmentUse {
	equipment_id: string;
	name: string;
	operations: number;
}

export function useProjectData(id: Ref<string>) {
	const { getItems, getItem } = useItems();
	const host = useExplorerHost();
	const gate = useRequestGate();
	const { section: block, fill } = useSections(gate);

	const project = ref<any | null>(null);
	const loading = ref(false);
	const notVisible = ref(false);
	const error = ref('');

	// One source for every block's starting data: it creates the sections and resets them when the page moves to another project.
	// "Who has access" is a fail-soft section: a failed read leaves `data` null and the hero shows the PI alone.
	const defaults = () => ({
		counts: { ...NO_COUNTS } as ProjectCounts,
		campaigns: [] as (any & { stats: CampaignProgress | null })[],
		looseSamples: [] as any[],
		looseOperations: [] as any[],
		looseTests: [] as any[],
		activity: { ops: [], tests: [], truncated: false, partialError: '' } as Activity,
		planned: { ops: [], tests: [] } as PlannedWork,
		equipment: [] as EquipmentUse[],
		access: null as AccessList | null,
	});
	type Defaults = ReturnType<typeof defaults>;
	type Sections = { [K in keyof Defaults]: Ref<SectionState<Defaults[K]>> };
	const sections = Object.fromEntries(Object.entries(defaults()).map(([key, data]) => [key, block(data)])) as unknown as Sections;
	const { counts, campaigns, looseSamples, looseOperations, looseTests, activity, planned, equipment, access } = sections;
	function resetSections() {
		const fresh = defaults();
		for (const key of Object.keys(sections) as (keyof Defaults)[]) {
			(sections[key] as Ref<SectionState<unknown>>).value = { data: fresh[key], loading: false, error: '' };
		}
	}

	// How many records a collection has per state, from one grouped read: the "done" ones (every state but planned) and the planned ones.
	// `field` is `work_state` for operations and tests, `current_status` for samples (migration 189). A collection the role cannot
	// read is null for both: the tile shows a dash rather than a wrong 0.
	async function stateCounts(collection: string, filter: Record<string, unknown>, field: string): Promise<{ done: number | null; planned: number | null }> {
		try {
			const groups = await getItems(collection, { aggregate: { count: '*' }, groupBy: [field], filter, limit: -1 });
			const planned = countsByKey(groups, field).get('planned') ?? 0;
			return { done: sumOf(groups) - planned, planned };
		} catch {
			return { done: null, planned: null };
		}
	}

	async function loadCampaigns(token: number, projectId: string) {
		const inProject = { campaign_id: { project_id: { _eq: projectId } } };
		const rows = await getItems('campaigns', {
			filter: { project_id: { _eq: projectId } },
			fields: [
				'campaign_id', 'campaign_code', 'name', 'campaign_type', 'status', 'start_date', 'end_date',
				'owner_person_id.person_id', 'owner_person_id.full_name',
			],
			sort: ['campaign_code', 'name'],
			limit: LIST_CAP + 1,
		});
		if (!gate.isCurrent(token)) return [];
		// The numbers behind the progress bars (the kit's loader, shared with the campaigns list). Each
		// read fails on its own: the cards then show no stats rather than no campaigns.
		const stats = await loadCampaignStats(getItems, rows, inProject);
		return rows.map((c: any) => ({ ...c, stats: stats?.get(c.campaign_id) ?? null }));
	}

	// "Who has access" is read on the first load and again after the dialog changed it, and the two can overlap. One sequence number
	// is shared by both: the latest call wins, and an older answer that lands later changes nothing. A failed read keeps the last list.
	let accessSeq = 0;
	async function fillAccess(projectId: string, withLoading: boolean) {
		const seq = ++accessSeq;
		if (withLoading) access.value = { ...access.value, loading: true, error: '' };
		const res = await loadAccess(host.api, 'projects', projectId).catch((e) => ({ ok: false as const, message: errorText(e) }));
		if (seq !== accessSeq || id.value !== projectId) return;
		access.value = res.ok
			? { data: res.data, loading: false, error: '' }
			: { ...access.value, loading: false, error: `Could not load who has access: ${res.message}` };
	}

	// The campaigns' total and how many each status has (for the totals line; the campaign list itself is capped), from one grouped read.
	async function campaignCounts(filter: Record<string, unknown>): Promise<{ total: number | null; statuses: Record<string, number> }> {
		try {
			const groups = await getItems('campaigns', { aggregate: { count: '*' }, groupBy: ['status'], filter, limit: -1 });
			return { total: sumOf(groups), statuses: Object.fromEntries(countsByKey(groups, 'status')) };
		} catch {
			return { total: null, statuses: {} };
		}
	}

	// Planned operations or tests per planned_date (a DATE column, so it can be grouped as it is). The timeline marks each day.
	async function loadPlannedDates(collection: string, projectId: string): Promise<PlannedInput[]> {
		const groups = await getItems(collection, {
			aggregate: { count: '*' },
			groupBy: ['planned_date'],
			filter: { _and: [projectScopeFilter(projectId), { work_state: { _eq: 'planned' } }, { planned_date: { _nnull: true } }] },
			limit: -1,
		});
		return plannedFromCounts(countsByKey(groups, 'planned_date'));
	}

	async function loadEquipment(projectId: string): Promise<EquipmentUse[]> {
		const groups = await getItems('manufacturing_operations', {
			aggregate: { count: '*' },
			groupBy: ['equipment_id'],
			filter: { _and: [projectScopeFilter(projectId), { equipment_id: { _nnull: true } }] },
			limit: -1,
		});
		const used = countsByKey(groups, 'equipment_id');
		if (!used.size) return [];
		const rows = await getItems('equipment', {
			filter: { equipment_id: { _in: [...used.keys()] } },
			fields: ['equipment_id', 'equipment_name'],
			limit: -1,
		});
		const names = new Map(rows.map((r: any) => [String(r.equipment_id), r.equipment_name as string]));
		return [...used.entries()]
			.map(([equipment_id, operations]) => ({ equipment_id, name: names.get(equipment_id) ?? 'Unnamed equipment', operations }))
			.sort((a, b) => b.operations - a.operations || a.name.localeCompare(b.name));
	}

	// The project row decides between "page" and "Not found or not visible to you". `isCurrent` says whether the answer is still wanted.
	async function readProject(projectId: string, isCurrent: () => boolean): Promise<boolean> {
		try {
			const row = await getItem('projects', projectId, { fields: PROJECT_FIELDS });
			if (!isCurrent()) return false;
			project.value = row;
			return true;
		} catch (e: any) {
			if (!isCurrent()) return false;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this project: ${errorText(e)}`;
			return false;
		}
	}

	async function load() {
		const token = gate.begin();
		const projectId = id.value;
		notVisible.value = false;
		error.value = '';
		// Reloading the same project keeps what is on screen; another project starts clean.
		if (project.value?.project_id !== projectId) {
			project.value = null;
			resetSections();
		}
		if (!projectId) return;

		loading.value = true;
		const found = await readProject(projectId, () => gate.isCurrent(token));
		if (gate.isCurrent(token)) loading.value = false;
		if (!found) return;

		const byProject = { project_id: { _eq: projectId } };
		await Promise.all([
			fill(counts, token, 'the totals', async () => {
				// "Belongs to the project" is one rule (projectScope.ts): own project_id, else the
				// campaign's. Samples also count when they are in one of the project's campaigns.
				// Operations and tests are grouped by `work_state`; a sample is planned by `current_status`
				// (migration 189), and the done figure leaves those out so "n planned" is not inside it.
				const scope = projectScopeFilter(projectId);
				const [samples, operations, tests, campaignTotals] = await Promise.all([
					stateCounts('physical_samples', sampleProjectScopeFilter(projectId), 'current_status'),
					stateCounts('manufacturing_operations', scope, 'work_state'),
					stateCounts('test_sessions', scope, 'work_state'),
					campaignCounts(byProject),
				]);
				return {
					samples: samples.done, operations: operations.done, tests: tests.done, campaigns: campaignTotals.total,
					samplesPlanned: samples.planned, operationsPlanned: operations.planned, testsPlanned: tests.planned,
					campaignStatuses: campaignTotals.statuses,
				};
			}),
			fill(campaigns, token, 'campaigns', () => loadCampaigns(token, projectId)),
			fill(looseSamples, token, 'samples outside campaigns', () =>
				getItems('physical_samples', {
					filter: {
						_and: [byProject, { campaigns: { _none: { campaign_id: { _nnull: true } } } }],
					},
					fields: ['sample_id', 'sample_code', 'form', 'current_status', 'material_id.common_name'],
					sort: ['sample_code'],
					limit: LIST_CAP + 1,
				}),
			),
			fill(looseOperations, token, 'operations outside campaigns', () =>
				getItems('manufacturing_operations', {
					filter: { _and: [byProject, { campaign_id: { _null: true } }] },
					fields: ['operation_id', 'pass_code', 'operation_sequence', 'process_category', 'operation_date', 'sample_id.sample_code'],
					sort: ['-operation_date'],
					limit: LIST_CAP + 1,
				}),
			),
			fill(looseTests, token, 'tests outside campaigns', () =>
				getItems('test_sessions', {
					filter: { _and: [byProject, { campaign_id: { _null: true } }] },
					fields: ['session_id', 'test_type', 'status', 'session_date', 'sample_id.sample_code'],
					sort: ['-session_date'],
					limit: LIST_CAP + 1,
				}),
			),
			fill(activity, token, 'activity', async () => {
				// The whole history, not 26 weeks: the timeline picks its range (30 d, 6 mo, All) from these dates.
				const rows = await fetchActivityRows(getItems, projectId);
				const partialError = rows.failed.map((f) => `Could not load ${f.collection} activity: ${errorText(f.error)}`).join(' ');
				return { ops: rows.ops.map((r) => r.operation_date), tests: rows.tests.map((r) => r.session_date), truncated: rows.truncated, partialError };
			}),
			fill(planned, token, 'planned work', async () => {
				const [ops, tests] = await Promise.all([loadPlannedDates('manufacturing_operations', projectId), loadPlannedDates('test_sessions', projectId)]);
				return { ops, tests };
			}),
			fill(equipment, token, 'equipment', () => loadEquipment(projectId)),
			fillAccess(projectId, true),
		]);
	}

	// After an edit: only the project row changes (the sections read other records), so only it is read again.
	async function reloadProject() {
		const projectId = id.value;
		if (!projectId) return;
		notVisible.value = false;
		error.value = '';
		await readProject(projectId, () => id.value === projectId);
	}

	// After the dialog changed "Who has access": a plain read (no loading flag), kept only if it is the latest and the page is still on the same project.
	async function reloadAccess() {
		const projectId = id.value;
		if (!projectId) return;
		await fillAccess(projectId, false);
	}

	watch(id, load, { immediate: true });
	onBeforeUnmount(() => gate.cancel());

	return {
		project, loading, notVisible, error,
		counts, campaigns, looseSamples, looseOperations, looseTests, activity, planned, equipment, access,
		reloadProject,
		/** Reads "Who has access" again, after the dialog changed it (nothing else on the page depends on it). */
		reloadAccess,
	};
}
