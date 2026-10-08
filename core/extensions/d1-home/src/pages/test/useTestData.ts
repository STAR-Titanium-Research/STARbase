import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import {
	errorText, isNotVisible, linkedFiles, paramColumns, paramRows, splitSubjects, TEST_SUBJECT_FIELDS, useFieldDefs, useItems,
	readHiddenLinks, useRequestGate, useSections, type LinkedFile, type ParamRow, type TestSubjects,
} from '@d1/ui';

// Everything the Test page reads, as the signed-in user. The test session decides between "page"
// and "Not found or not visible to you"; every other block loads on its own (same pattern as the
// Sample and Operation pages).

const TEST_FIELDS = [
	'session_id', 'test_type', 'test_category', 'session_date', 'status', 'operator_name', 'notes',
	'summary_stats', 'capture_software', 'capture_frequency_khz', 'file_size_gb', 'file_storage_pointer',
	'equipment_id.equipment_id', 'equipment_id.equipment_name',
	'project_id.project_id', 'project_id.project_code', 'project_id.project_name',
	'campaign_id.campaign_id', 'campaign_id.campaign_code', 'campaign_id.name',
	'owner_person_id.person_id', 'owner_person_id.full_name',
	'operator_person_id.person_id', 'operator_person_id.full_name',
	// The primary sample. A test made through the form records its targets in the subject junction
	// (test_sessions_subject); since migration 139 a trigger keeps this column equal to the junction's
	// first sample, so it is filled for those tests too. Further samples exist only in the junction,
	// which `subjects` reads.
	'sample_id.sample_id', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.form', 'sample_id.current_status',
];

// Links that read as "none" when the target is hidden by row-level visibility (ADR-0011).
const LINK_FIELDS = ['sample_id', 'project_id', 'campaign_id'];

export function useTestData(id: Ref<string>) {
	const { getItem, getItems } = useItems();
	const { getFieldDefs } = useFieldDefs();
	const gate = useRequestGate();
	const { section, fill } = useSections(gate);

	const test = ref<any | null>(null);
	const loading = ref(false);
	const notVisible = ref(false);
	const error = ref('');

	const params = section<ParamRow[]>([]);
	const subjects = section<TestSubjects>({ samples: [], others: [], hidden: 0 });
	const files = section<LinkedFile[]>([]);
	const hidden = section<Record<string, boolean>>({});

	async function readParams(sessionId: string, testType: string | null): Promise<ParamRow[]> {
		if (!testType) return [];
		const defs = await getFieldDefs('test_sessions');
		const columns = paramColumns(defs, 'test_type', testType);
		if (!columns.length) return [];
		const row = await getItem('test_sessions', sessionId, { fields: columns });
		return paramRows(defs, { ...row, test_type: testType }, 'test_type');
	}

	// One read: the junction rows with each target's own fields (M2A syntax), so the samples need
	// no second request.
	async function readSubjects(sessionId: string): Promise<TestSubjects> {
		try {
			const rows = await getItems('test_sessions_subject', {
				filter: { test_sessions_id: { _eq: sessionId } },
				fields: TEST_SUBJECT_FIELDS,
				sort: ['id'],
				limit: 50,
			});
			return splitSubjects(rows);
		} catch (e) {
			if (isNotVisible(e)) return { samples: [], others: [], hidden: 0 };
			throw e;
		}
	}

	async function load() {
		const token = gate.begin();
		const sessionId = id.value;
		notVisible.value = false;
		error.value = '';
		if (test.value?.session_id !== sessionId) {
			test.value = null;
			params.value = { data: [], loading: false, error: '' };
			subjects.value = { data: { samples: [], others: [], hidden: 0 }, loading: false, error: '' };
			files.value = { data: [], loading: false, error: '' };
			hidden.value = { data: {}, loading: false, error: '' };
		}
		if (!sessionId) return;

		loading.value = true;
		try {
			const row = await getItem('test_sessions', sessionId, { fields: TEST_FIELDS });
			if (!gate.isCurrent(token)) return;
			test.value = row;
		} catch (e: any) {
			if (!gate.isCurrent(token)) return;
			if (isNotVisible(e)) notVisible.value = true;
			else error.value = `Could not load this test: ${errorText(e)}`;
			return;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}

		const testType: string | null = test.value?.test_type ?? null;
		await Promise.all([
			fill(hidden, token, 'linked records', () => readHiddenLinks(getItem, 'test_sessions', sessionId, test.value, LINK_FIELDS)),
			fill(params, token, 'the parameters', () => readParams(sessionId, testType)),
			fill(subjects, token, 'the test subject', () => readSubjects(sessionId)),
			fill(files, token, 'linked files', async () => {
				const item = await getItem('test_sessions', sessionId, {
					fields: [
						'data_files.directus_files_id.id',
						'data_files.directus_files_id.title',
						'data_files.directus_files_id.filename_download',
						'data_files.directus_files_id.metadata',
					],
				});
				return linkedFiles(item?.data_files);
			}),
		]);
	}

	watch(id, load, { immediate: true });
	onBeforeUnmount(() => gate.cancel());

	return { test, loading, notVisible, error, params, subjects, files, hidden, reload: load };
}
