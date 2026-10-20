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

/** Dates of the done operations and tests over the project's whole history (the timeline picks its range from them). */
export interface Activity {
	ops: string[];
	tests: string[];
	/** The read hit its row cap: the oldest records are missing. */
	truncated: boolean;
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

	const counts = block<ProjectCounts>({ ...NO_COUNTS });
	const campaigns = block<(any & { stats: CampaignProgress | null })[]>([]);
	const looseSamples = block<any[]>([]);
	const looseOperations = block<any[]>([]);
	const looseTests = block<any[]>([]);
	const activity = block<Activity>({ ops: [], tests: [], truncated: false });
	const planned = block<PlannedWork>({ ops: [], tests: [] });
	const equipment = block<EquipmentUse[]>([]);
	// "Who has access": its own fail-soft section. A failed read leaves `data` null and the hero shows the PI alone.
	const access = block<AccessList | null>(null);

	const all = [counts, campaigns, looseSamples, looseOperations, looseTests, activity, planned, equipment, access] as Ref<SectionState<any>>[];
	const initial = (b: Ref<SectionState<any>>) =>
		b === activity ? { ops: [], tests: [], truncated: false } : b === planned ? { ops: [], tests: [] } : b === counts ? { ...NO_COUNTS } : b === access ? null : [];

	const count = async (collection: string, filter: Record<string, unknown>): Promise<number | null> => {
		try {
			const rows = await getItems(collection, { aggregate: { count: '*' }, filter, limit: 1 });
			return Number(rows[0]?.count ?? 0);
		} catch {
			// A collection the role cannot read: the tile shows a dash rather than a wrong 0.
			return null;
		}
	};

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

	// "Who has access" has a gate of its own: reading it again after the dialog changed it must not cancel the page's other reads.
	const accessGate = useRequestGate();
	const { fill: fillAccess } = useSections(accessGate);
	function loadAccessList(projectId: string) {
		return fillAccess(access, accessGate.begin(), 'who has access', async () => {
			const res = await loadAccess(host.api, 'projects', projectId);
			if (!res.ok) throw new Error(res.message);
			return res.data;
		});
	}

	// How many campaigns each status has, for the totals line (the campaign list itself is capped).
	async function campaignStatuses(filter: Record<string, unknown>): Promise<Record<string, number>> {
		try {
			const groups = await getItems('campaigns', { aggregate: { count: '*' }, groupBy: ['status'], filter, limit: -1 });
			return Object.fromEntries(countsByKey(groups, 'status'));
		} catch {
			return {};
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

	async function load() {
		const token = gate.begin();
		const projectId = id.value;
		notVisible.value = false;
		error.value = '';
		// Reloading the same project (after an edit) keeps what is on screen; another project starts clean.
		if (project.value?.project_id !== projectId) {
			project.value = null;
			for (const b of all) b.value = { data: initial(b), loading: false, error: '' };
		}
		if (!projectId) return;

		loading.value = true;
		try {
			const row = await getItem('projects', projectId, { fields: PROJECT_FIELDS });
			if (!gate.isCurrent(token)) return;
			project.value = row;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this project: ${errorText(e)}`;
			return;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}

		const byProject = { project_id: { _eq: projectId } };
		await Promise.all([
			fill(counts, token, 'the totals', async () => {
				// "Belongs to the project" is one rule (projectScope.ts): own project_id, else the
				// campaign's. Samples also count when they are in one of the project's campaigns.
				// Operations and tests are counted by `work_state`; a sample is planned by `current_status`
				// (migration 189), and the done figure leaves those out so "n planned" is not inside it.
				const scope = projectScopeFilter(projectId);
				const sampleScope = sampleProjectScopeFilter(projectId);
				const state = (s: Record<string, unknown>, work: 'done' | 'planned') => ({ _and: [s, { work_state: { _eq: work } }] });
				const [samples, operations, tests, campaignCount, samplesPlanned, operationsPlanned, testsPlanned, statuses] = await Promise.all([
					count('physical_samples', { _and: [sampleScope, { current_status: { _neq: 'planned' } }] }),
					count('manufacturing_operations', state(scope, 'done')),
					count('test_sessions', state(scope, 'done')),
					count('campaigns', byProject),
					count('physical_samples', { _and: [sampleScope, { current_status: { _eq: 'planned' } }] }),
					count('manufacturing_operations', state(scope, 'planned')),
					count('test_sessions', state(scope, 'planned')),
					campaignStatuses(byProject),
				]);
				return { samples, operations, tests, campaigns: campaignCount, samplesPlanned, operationsPlanned, testsPlanned, campaignStatuses: statuses };
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
				const rows = await fetchActivityRows(getItems, projectId, null);
				return { ops: rows.ops.map((r) => r.operation_date), tests: rows.tests.map((r) => r.session_date), truncated: rows.truncated };
			}),
			fill(planned, token, 'planned work', async () => {
				const [ops, tests] = await Promise.all([loadPlannedDates('manufacturing_operations', projectId), loadPlannedDates('test_sessions', projectId)]);
				return { ops, tests };
			}),
			fill(equipment, token, 'equipment', () => loadEquipment(projectId)),
			loadAccessList(projectId),
		]);
	}

	async function reloadAccess() {
		if (id.value) await loadAccessList(id.value);
	}

	watch(id, load, { immediate: true });
	onBeforeUnmount(() => {
		gate.cancel();
		accessGate.cancel();
	});

	return {
		project, loading, notVisible, error,
		counts, campaigns, looseSamples, looseOperations, looseTests, activity, planned, equipment, access,
		reload: load,
		/** Reads "Who has access" again, after the dialog changed it (nothing else on the page depends on it). */
		reloadAccess,
	};
}
