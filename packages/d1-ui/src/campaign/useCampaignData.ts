import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { useItems } from '../composables/useItems';
import { useRequestGate } from '../composables/useRequestGate';
import { useSections } from '../composables/useSections';
import { buildMatrix } from './matrix';
import { isForbidden } from '../format';
import { buildOverview } from './rollup';

// Everything the campaign overview needs, read as the signed-in user (so Directus permissions
// apply). The four reads run in parallel and each fails on its own: a role that may not read
// `machining_force_analysis` still sees the samples, operations and tests, with a note.

export function useCampaignData(campaignId: Ref<string>) {
	const { getItems } = useItems();
	const gate = useRequestGate();
	const { section, fill } = useSections(gate);

	const junction = section<any[]>([]);
	const operations = section<any[]>([]);
	const tests = section<any[]>([]);
	const analyses = section<any[]>([]);
	// No access to the force-analysis table is a normal state for some roles: say so, don't alarm.
	const analysisUnavailable = ref(false);

	async function load() {
		const token = gate.begin();
		const cid = campaignId.value;
		if (!cid) return;
		analysisUnavailable.value = false;
		await Promise.all([
			fill(junction, token, 'the sample list', () =>
				getItems('campaign_samples', {
					filter: { campaign_id: { _eq: cid } },
					fields: ['id', 'sample_id.sample_id', 'sample_id.sample_code'],
					limit: -1,
				}),
			),
			fill(operations, token, "the campaign's operations", () =>
				getItems('manufacturing_operations', {
					filter: { campaign_id: { _eq: cid } },
					fields: [
						'operation_id', 'pass_code', 'operation_sequence', 'process_category',
						'sample_id.sample_id', 'sample_id.sample_code',
					],
					sort: ['operation_sequence', 'pass_code'],
					limit: -1,
				}),
			),
			fill(tests, token, 'test sessions', () =>
				getItems('test_sessions', {
					filter: { campaign_id: { _eq: cid } },
					fields: ['session_id', 'test_type', 'status', 'session_date', 'sample_id.sample_id', 'sample_id.sample_code'],
					sort: ['-session_date'],
					limit: -1,
				}),
			),
			fill(
				analyses,
				token,
				'force-analysis status',
				() =>
					getItems('machining_force_analysis', {
						filter: { operation_id: { campaign_id: { _eq: cid } } },
						fields: ['operation_id', 'status', 'error_message', 'diag_status', 'diag_error'],
						limit: -1,
					}),
				(e) => {
					if (!isForbidden(e)) return false;
					analysisUnavailable.value = true;
					return true;
				},
			),
		]);
	}

	function reset() {
		for (const s of [junction, operations, tests, analyses]) s.value = { data: [], loading: false, error: '' };
	}

	watch(
		campaignId,
		() => {
			reset();
			load();
		},
		{ immediate: true },
	);
	onBeforeUnmount(() => gate.cancel());

	const input = computed(() => ({
		samples: junction.value.data,
		operations: operations.value.data,
		tests: tests.value.data,
		analyses: analyses.value.data,
	}));
	const overview = computed(() => buildOverview(input.value));
	const matrix = computed(() => buildMatrix(input.value));
	const loading = computed(
		() => junction.value.loading || operations.value.loading || tests.value.loading || analyses.value.loading,
	);

	return { junction, operations, tests, analyses, analysisUnavailable, overview, matrix, loading, reload: load };
}
