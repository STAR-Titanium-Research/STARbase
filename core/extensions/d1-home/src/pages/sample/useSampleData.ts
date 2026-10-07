import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { LIST_CAP, errorText, isNotVisible, useItems, useRequestGate, useSections, type LinkedFile, type SectionState, linkedFiles, type TraceResponse } from '@d1/ui';

// Everything the Sample page reads, as the signed-in user (so Directus permissions apply). The
// sample itself decides between "page" and "Not found or not visible to you"; everything else is a
// section that loads in parallel and fails on its own, so one slow or forbidden list does not blank
// the page.

const SAMPLE_FIELDS = [
	'sample_id', 'sample_code', 'nickname', 'form', 'current_status', 'item_type', 'stock_category',
	'location', 'notes', 'surface_finish', 'manufacturing_route', 'manufactured_date', 'mounted',
	'mounting_method', 'export_controlled', 'mass_grams', 'diameter_mm', 'length_mm',
	'width_mm', 'thickness_mm', 'gauge_length_mm', 'gauge_width_mm', 'created_at', 'updated_at', 'version',
	'material_id.material_id', 'material_id.common_name', 'material_id.alloy_code', 'material_id.density_g_per_cm3',
	'project_id.project_id', 'project_id.project_code', 'project_id.project_name',
	'owner_person_id.person_id', 'owner_person_id.full_name',
	// `co_owners` is the M2M alias over sample_co_owners (users); the legacy TEXT column of the
	// same name is not what the form shows, so read the people through the junction.
	'co_owners.user_id.first_name', 'co_owners.user_id.last_name',
	'primary_method_id.method_id', 'primary_method_id.method_name',
];

export function useSampleData(id: Ref<string>) {
	const api = useApi();
	const { getItem, getItems } = useItems();
	const gate = useRequestGate();
	const { section, fill } = useSections(gate);

	const sample = ref<any | null>(null);
	const loading = ref(false);
	const notVisible = ref(false);
	const error = ref('');

	const elements = section<any[]>([]);
	const campaigns = section<any[]>([]);
	const operations = section<any[]>([]);
	const tests = section<any[]>([]);
	const files = section<LinkedFile[]>([]);
	const trace = section<TraceResponse | null>(null);

	async function load() {
		const token = gate.begin();
		const sampleId = id.value;
		notVisible.value = false;
		error.value = '';
		// Reloading the same sample (after an edit) keeps what is on screen until the new data
		// arrives; moving to another sample starts from a clean page.
		if (sample.value?.sample_id !== sampleId) {
			sample.value = null;
			for (const s of [elements, campaigns, operations, tests, files, trace] as Ref<SectionState<any>>[]) {
				s.value = { data: s === trace ? null : [], loading: false, error: '' };
			}
		}
		if (!sampleId) return;

		loading.value = true;
		try {
			const row = await getItem('physical_samples', sampleId, { fields: SAMPLE_FIELDS });
			if (!gate.isCurrent(token)) return;
			sample.value = row;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this sample: ${errorText(e)}`;
			return;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}

		const materialId = sample.value?.material_id?.material_id;
		await Promise.all([
			fill(trace, token, 'the sample history', async () => (await api.get(`/d1-trace/sample/${sampleId}`)).data),
			fill(operations, token, 'operations', () =>
				getItems('manufacturing_operations', {
					filter: { sample_id: { _eq: sampleId } },
					fields: [
						'operation_id', 'pass_code', 'operation_sequence', 'operation_date', 'process_category',
						'method_id.method_name', 'equipment_id.equipment_name', 'operator_name',
					],
					sort: ['operation_sequence', 'operation_date'],
					limit: LIST_CAP + 1,
				}),
			),
			fill(tests, token, 'tests', async () => {
				const fields = ['session_id', 'test_type', 'test_category', 'session_date', 'status', 'equipment_id.equipment_name', 'operator_name'];
				const read = (filter: Record<string, unknown>) =>
					getItems('test_sessions', { filter, fields, sort: ['session_date'], limit: LIST_CAP + 1 });
				// sample_id is the test's primary sample (kept in step with the subject junction by a
				// trigger); a test with several samples lists the others only in the junction. One read
				// with an _or, sorted and capped by the server, covers both.
				const direct = { sample_id: { _eq: sampleId } };
				const viaSubject = { subject: { _some: { _and: [{ collection: { _eq: 'physical_samples' } }, { item: { _eq: sampleId } }] } } };
				try {
					return await read({ _or: [direct, viaSubject] });
				} catch (e) {
					// A role that may not read the junction cannot filter on it: fall back to the primary sample.
					if (!isNotVisible(e)) throw e;
					return read(direct);
				}
			}),
			fill(campaigns, token, 'campaigns', () =>
				getItems('campaign_samples', {
					filter: { sample_id: { _eq: sampleId } },
					fields: ['campaign_id.campaign_id', 'campaign_id.campaign_code', 'campaign_id.name'],
					limit: 20,
				}),
			),
			fill(files, token, 'linked files', async () => {
				const item = await getItem('physical_samples', sampleId, {
					fields: [
						'data_files.directus_files_id.id',
						'data_files.directus_files_id.title',
						'data_files.directus_files_id.filename_download',
						'data_files.directus_files_id.metadata',
					],
				});
				return linkedFiles(item?.data_files);
			}),
			materialId
				? fill(elements, token, 'the composition', () =>
						getItems('material_alloying_elements', {
							filter: { material_id: { _eq: materialId } },
							fields: ['symbol', 'weight_percent'],
							limit: -1,
						}),
					)
				: Promise.resolve((elements.value = { data: [], loading: false, error: '' })),
		]);
	}

	watch(id, load, { immediate: true });
	onBeforeUnmount(() => gate.cancel());

	return { sample, loading, notVisible, error, elements, campaigns, operations, tests, files, trace, reload: load };
}
