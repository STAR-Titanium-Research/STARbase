import { onBeforeUnmount, ref } from 'vue';
import {
	CURRENT_USER, countsByKey, datesByKey, errorText, fetchActivityRows, useItems, useRequestGate, weeklyActivity, DEFAULT_WEEKS,
	type ProjectRow, type WeeklyActivity,
} from '@d1/ui';

// Everything the Projects index reads, as the signed-in user. The project list is the page; the
// counts, the activity and the user's investigator memberships load in parallel and fail on their
// own, so a role that cannot read samples (or the project_investigators junction) still gets its
// project cards. The junction is not part of the project read for the same reason: a field the
// role may not read would fail the whole request.

export const PROJECT_CAP = 500;

export interface IndexProject extends ProjectRow {
	description?: string | null;
	start_date?: string | null;
	end_date?: string | null;
}

const PROJECT_FIELDS = [
	'project_id', 'project_code', 'project_name', 'is_active', 'start_date', 'end_date',
	'principal_investigator_person.person_id', 'principal_investigator_person.full_name',
	'principal_investigator_person.user_id',
];

export function useProjectsIndex() {
	const { getItems } = useItems();
	const gate = useRequestGate();

	const projects = ref<IndexProject[]>([]);
	const loading = ref(false);
	const error = ref('');

	const campaignCounts = ref(new Map<string, number>());
	const sampleCounts = ref(new Map<string, number>());
	// Each count loads on its own, so one collection the role cannot read leaves the other intact.
	const campaignCountsError = ref('');
	const sampleCountsError = ref('');
	const activity = ref(new Map<string, WeeklyActivity>());
	const activityError = ref('');
	const truncated = ref(false);
	const rolesError = ref('');

	async function load() {
		const token = gate.begin();
		loading.value = true;
		error.value = '';
		campaignCountsError.value = '';
		sampleCountsError.value = '';
		activityError.value = '';
		rolesError.value = '';
		try {
			const rows = await getItems('projects', { fields: PROJECT_FIELDS, sort: ['project_code'], limit: PROJECT_CAP });
			if (!gate.isCurrent(token)) return;
			projects.value = rows;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			error.value = `Could not load projects: ${errorText(e)}`;
			projects.value = [];
			return;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}

		// Known limit: a grouped aggregate cannot express the kit-wide "belongs to project" rule
		// (own project_id, else the campaign's: projectScope.ts), so these counts group on the
		// record's own project_id. Campaigns always have one; for samples that is right once the
		// campaign pickers copy the campaign's project onto the sample (they do, when it has none),
		// and legacy samples that only sit in a campaign are counted on the Project page, not here.
		// The activity sparkline below is exact: it reads rows and applies the rule per row.
		const grouped = (collection: string) =>
			getItems(collection, {
				aggregate: { count: '*' },
				groupBy: ['project_id'],
				filter: { project_id: { _nnull: true } },
				limit: -1,
			});

		await Promise.all([
			(async () => {
				// Only the signed-in user's own rows: enough to mark "you are investigator".
				try {
					const mine = await getItems('project_investigators', {
						filter: { user_id: { _eq: CURRENT_USER } },
						fields: ['project_id', 'user_id'],
						limit: -1,
					});
					if (!gate.isCurrent(token)) return;
					const byProject = new Map(mine.map((m: any) => [String(m.project_id), m.user_id]));
					projects.value = projects.value.map((p) =>
						byProject.has(p.project_id) ? { ...p, secondary_investigators: [{ user_id: byProject.get(p.project_id) }] } : p,
					);
				} catch (e: any) {
					if (gate.isCurrent(token)) rolesError.value = `Could not check your investigator roles: ${errorText(e)}`;
				}
			})(),
			(async () => {
				try {
					const campaigns = await grouped('campaigns');
					if (gate.isCurrent(token)) campaignCounts.value = countsByKey(campaigns, 'project_id');
				} catch (e: any) {
					if (gate.isCurrent(token)) campaignCountsError.value = `Could not load campaign counts: ${errorText(e)}`;
				}
			})(),
			(async () => {
				try {
					const samples = await grouped('physical_samples');
					if (gate.isCurrent(token)) sampleCounts.value = countsByKey(samples, 'project_id');
				} catch (e: any) {
					if (gate.isCurrent(token)) sampleCountsError.value = `Could not load sample counts: ${errorText(e)}`;
				}
			})(),
			(async () => {
				try {
					const rows = await fetchActivityRows(getItems);
					if (!gate.isCurrent(token)) return;
					const ops = datesByKey(rows.ops, (r) => r.project_id, (r) => r.operation_date);
					const tests = datesByKey(rows.tests, (r) => r.project_id, (r) => r.session_date);
					const now = new Date();
					const out = new Map<string, WeeklyActivity>();
					for (const p of projects.value) {
						out.set(p.project_id, weeklyActivity(ops.get(p.project_id) ?? [], tests.get(p.project_id) ?? [], DEFAULT_WEEKS, now));
					}
					activity.value = out;
					truncated.value = rows.truncated;
				} catch (e: any) {
					if (gate.isCurrent(token)) activityError.value = `Could not load activity: ${errorText(e)}`;
				}
			})(),
		]);
	}

	load();
	onBeforeUnmount(() => gate.cancel());

	return { projects, loading, error, campaignCounts, sampleCounts, campaignCountsError, sampleCountsError, activity, activityError, truncated, rolesError, reload: load };
}
