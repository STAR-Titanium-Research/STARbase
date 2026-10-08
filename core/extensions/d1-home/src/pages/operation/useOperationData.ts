import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
	LIST_CAP, errorText, isNotVisible, linkedFiles, paramColumns, paramRows, shareFiles, useFieldDefs, useItems, useRequestGate,
	readHiddenLinks, useSections, type LinkedFile, type ParamRow,
} from '@d1/ui';

// Everything the Operation page reads, as the signed-in user. The operation itself decides between
// "page" and "Not found or not visible to you"; every other block is a section that loads in
// parallel and fails on its own (same pattern as the Sample page).

const OPERATION_FIELDS = [
	'operation_id', 'pass_code', 'operation_sequence', 'operation_date', 'process_category', 'operator_name',
	'outcome_notes', 'capture_software', 'capture_frequency_khz', 'force_file_id', 'source_system',
	'method_id.method_id', 'method_id.method_name',
	'equipment_id.equipment_id', 'equipment_id.equipment_name',
	'project_id.project_id', 'project_id.project_code', 'project_id.project_name',
	'campaign_id.campaign_id', 'campaign_id.campaign_code', 'campaign_id.name',
	'owner_person_id.person_id', 'owner_person_id.full_name',
	'operator_person_id.person_id', 'operator_person_id.full_name',
	// Input = the workpiece acted on; output = the sample this step produced (produced_by_operations
	// is the same relation read from the sample side).
	'sample_id.sample_id', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.form', 'sample_id.current_status',
	'output_sample_id.sample_id', 'output_sample_id.sample_code', 'output_sample_id.nickname', 'output_sample_id.form',
	'output_sample_id.current_status',
];

// Links that read as "none" when the target is hidden by row-level visibility (ADR-0011).
const LINK_FIELDS = ['sample_id', 'output_sample_id', 'project_id', 'campaign_id'];

export function useOperationData(id: Ref<string>) {
	const { getItem, getItems } = useItems();
	const { getFieldDefs } = useFieldDefs();
	const gate = useRequestGate();
	const { section, fill } = useSections(gate);

	const operation = ref<any | null>(null);
	const loading = ref(false);
	const notVisible = ref(false);
	const error = ref('');

	const params = section<ParamRow[]>([]);
	const force = section<any[]>([]);
	const fast = section<any | null>(null);
	const files = section<LinkedFile[]>([]);
	const shared = section<LinkedFile[]>([]);
	const hidden = section<Record<string, boolean>>({});

	async function readParams(opId: string, category: string | null): Promise<ParamRow[]> {
		if (!category) return [];
		const defs = await getFieldDefs('manufacturing_operations');
		const columns = paramColumns(defs, 'process_category', category);
		if (!columns.length) return [];
		const row = await getItem('manufacturing_operations', opId, { fields: columns });
		return paramRows(defs, { ...row, process_category: category }, 'process_category');
	}

	async function load() {
		const token = gate.begin();
		const opId = id.value;
		notVisible.value = false;
		error.value = '';
		if (operation.value?.operation_id !== opId) {
			operation.value = null;
			params.value = { data: [], loading: false, error: '' };
			force.value = { data: [], loading: false, error: '' };
			fast.value = { data: null, loading: false, error: '' };
			files.value = { data: [], loading: false, error: '' };
			shared.value = { data: [], loading: false, error: '' };
			hidden.value = { data: {}, loading: false, error: '' };
		}
		if (!opId) return;

		loading.value = true;
		try {
			const row = await getItem('manufacturing_operations', opId, { fields: OPERATION_FIELDS });
			if (!gate.isCurrent(token)) return;
			operation.value = row;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this operation: ${errorText(e)}`;
			return;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}

		const category: string | null = operation.value?.process_category ?? null;
		await Promise.all([
			fill(hidden, token, 'linked records', () => readHiddenLinks(getItem, 'manufacturing_operations', opId, operation.value, LINK_FIELDS)),
			fill(params, token, 'the parameters', () => readParams(opId, category)),
			// Force analysis exists for machining operations, the FAST trace for sintering ones (the same
			// split analysisLink() in the kit makes); other categories have neither, so no request.
			fill(force, token, 'the force analysis', () =>
				category !== 'machining' ? Promise.resolve([]) : getItems('machining_force_analysis', {
					filter: { operation_id: { _eq: opId } },
					fields: [
						'id', 'status', 'diag_status', 'error_message', 'diag_error', 'processed_at',
						'directus_files_id.id', 'directus_files_id.filename_download', 'directus_files_id.title',
					],
					sort: ['id'],
					limit: LIST_CAP + 1,
				}),
			),
			fill(fast, token, 'the FAST run', async () => {
				if (category !== 'sintering') return null;
				const rows = await getItems('fast_run_data', {
					filter: { operation_id: { _eq: opId } },
					fields: ['id', 'status', 'error_message', 'recipe', 'plant', 'run_start', 'duration_s', 'n_rows', 'processed_at'],
					limit: 1,
				});
				return rows[0] ?? null;
			}),
			fill(files, token, 'linked files', async () => {
				const item = await getItem('manufacturing_operations', opId, {
					fields: [
						'data_files.directus_files_id.id',
						'data_files.directus_files_id.title',
						'data_files.directus_files_id.filename_download',
						'data_files.directus_files_id.metadata',
					],
				});
				return linkedFiles(item?.data_files);
			}),
			// Legacy network-share links. The collection is not part of the Lab Member grants, so a
			// refusal is "none for you", not an error worth showing on every operation.
			fill(shared, token, 'network-share files', async () => {
				try {
					const rows = await getItems('operation_files', {
						filter: { operation_id: { _eq: opId } },
						fields: ['file_id', 'file_path', 'file_name'],
						sort: ['file_name'],
						limit: 200,
					});
					return shareFiles(rows);
				} catch (e) {
					if (isNotVisible(e)) return [];
					throw e;
				}
			}),
		]);
	}

	watch(id, load, { immediate: true });
	onBeforeUnmount(() => gate.cancel());

	return { operation, loading, notVisible, error, params, force, fast, files, shared, hidden, reload: load };
}
