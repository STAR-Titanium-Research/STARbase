import { computed, onBeforeUnmount, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import {
	LABEL_SAMPLE_FIELDS, clampCopies, errorText, pickerFilter, sampleProjectScopeFilter, toLabelSample, useRequestGate, type LabelSample,
} from '@d1/ui';

// The samples of the labels page: what is ticked (kept apart from the search results, so a new search never
// drops a pick), the picker's search, and resolving ids and codes from the URL or the paste box. Every read is
// the signed-in user's: a sample they cannot read is reported as not found.

export const PICKER_LIMIT = 100;
export const OPTIONS_LIMIT = 200;
const CHUNK = 50;
const chunks = <T,>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export interface Option {
	value: string;
	label: string;
	projectId?: string | null;
}

export function useLabelSamples() {
	const api = useApi();
	const gate = useRequestGate();
	onBeforeUnmount(() => gate.cancel());

	const selected = ref<LabelSample[]>([]);
	function add(samples: LabelSample[]): void {
		const have = new Set(selected.value.map((s) => s.id));
		for (const s of samples) {
			if (have.has(s.id)) continue;
			selected.value.push(s);
			have.add(s.id);
		}
	}
	// Copies typed on one sample; every other sample follows the global copies (see sampleEntries).
	const copyOverrides = ref<Record<string, number>>({});
	function setCopies(id: string, value: unknown): void {
		copyOverrides.value = { ...copyOverrides.value, [id]: clampCopies(value) };
	}
	const dropOverride = (id: string): void => {
		const { [id]: _gone, ...rest } = copyOverrides.value;
		copyOverrides.value = rest;
	};
	const remove = (id: string): void => {
		selected.value = selected.value.filter((s) => s.id !== id);
		dropOverride(id);
	};
	const clear = (): void => {
		selected.value = [];
		copyOverrides.value = {};
	};

	// ---- the picker ----------------------------------------------------------------------------
	const search = ref('');
	const projectId = ref('');
	const campaignId = ref('');
	const results = ref<LabelSample[]>([]);
	const total = ref<number | null>(null);
	const loading = ref(false);
	const error = ref('');

	async function runSearch(): Promise<void> {
		const token = gate.begin();
		loading.value = true;
		error.value = '';
		try {
			const filter = pickerFilter({
				search: search.value,
				campaignId: campaignId.value,
				projectScope: projectId.value ? sampleProjectScopeFilter(projectId.value) : null,
			});
			const res = await api.get('/items/physical_samples', {
				params: { fields: LABEL_SAMPLE_FIELDS, filter, sort: ['-created_at'], limit: PICKER_LIMIT, meta: 'filter_count' },
			});
			if (!gate.isCurrent(token)) return;
			results.value = (res.data?.data ?? []).map(toLabelSample);
			total.value = res.data?.meta?.filter_count ?? results.value.length;
		} catch (e) {
			if (!gate.isCurrent(token)) return;
			error.value = `Could not load samples: ${errorText(e)}`;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	// The filters' choices. Each read stands alone (one forbidden list must not blank the other) and is capped:
	// past OPTIONS_LIMIT the dropdown is cut and says so. With a project chosen the campaigns are read again,
	// filtered by that project on the server, so a long campaign list still reaches the project's own.
	const projects = ref<Option[]>([]);
	const campaigns = ref<Option[]>([]);
	const projectNote = ref('');
	const campaignNote = ref('');
	const optionsError = computed(() => [projectNote.value, campaignNote.value].filter(Boolean).join(' '));
	const cutNote = (name: string, total: unknown): string =>
		typeof total === 'number' && total > OPTIONS_LIMIT ? `The ${name} filter lists the first ${OPTIONS_LIMIT} of ${total}; paste the sample codes instead.` : '';
	const campaignGate = useRequestGate();

	async function loadProjects(): Promise<void> {
		try {
			const res = await api.get('/items/projects', {
				params: { fields: ['project_id', 'project_code', 'project_name'], sort: ['project_code'], limit: OPTIONS_LIMIT, meta: 'filter_count' },
			});
			projects.value = (res.data?.data ?? []).map((r: any) => ({ value: r.project_id, label: r.project_code || r.project_name || 'Project' }));
			projectNote.value = cutNote('project', res.data?.meta?.filter_count);
		} catch (e) {
			projectNote.value = `Could not load the project filter: ${errorText(e)}`;
		}
	}
	async function loadCampaigns(forProject = ''): Promise<void> {
		const token = campaignGate.begin();
		try {
			const res = await api.get('/items/campaigns', {
				params: {
					fields: ['campaign_id', 'campaign_code', 'name', 'project_id'], sort: ['campaign_code'], limit: OPTIONS_LIMIT, meta: 'filter_count',
					...(forProject ? { filter: { project_id: { _eq: forProject } } } : {}),
				},
			});
			if (!campaignGate.isCurrent(token)) return;
			campaigns.value = (res.data?.data ?? []).map((r: any) => ({
				value: r.campaign_id,
				label: r.campaign_code || r.name || 'Campaign',
				projectId: r.project_id && typeof r.project_id === 'object' ? r.project_id.project_id : r.project_id,
			}));
			campaignNote.value = cutNote('campaign', res.data?.meta?.filter_count);
		} catch (e) {
			if (campaignGate.isCurrent(token)) campaignNote.value = `Could not load the campaign filter: ${errorText(e)}`;
		}
	}
	const loadOptions = (): Promise<unknown> => Promise.allSettled([loadProjects(), loadCampaigns()]);

	// ---- resolving ids and codes ------------------------------------------------------------------
	// Adds the samples with these ids or codes to the selection, in the order asked, and returns what could not
	// be found (missing, or not visible to this user).
	async function lookup(ids: string[], codes: string[]): Promise<{ found: LabelSample[]; missing: string[] }> {
		const read = async (field: 'sample_id' | 'sample_code', values: string[]): Promise<Map<string, LabelSample>> => {
			const out = new Map<string, LabelSample>();
			for (const part of chunks(values, CHUNK)) {
				const res = await api.get('/items/physical_samples', {
					params: { fields: LABEL_SAMPLE_FIELDS, filter: { [field]: { _in: part } }, limit: -1 },
				});
				for (const row of res.data?.data ?? []) {
					const s = toLabelSample(row);
					out.set(field === 'sample_id' ? s.id : s.code, s);
				}
			}
			return out;
		};
		const none = new Map<string, LabelSample>();
		const [byId, byCode] = await Promise.all([ids.length ? read('sample_id', ids) : none, codes.length ? read('sample_code', codes) : none]);
		const found: LabelSample[] = [];
		const missing: string[] = [];
		for (const id of ids) {
			const s = byId.get(id);
			if (s) found.push(s);
			else missing.push(id);
		}
		for (const code of codes) {
			const s = byCode.get(code);
			if (s) found.push(s);
			else missing.push(code);
		}
		return { found, missing };
	}
	async function resolve(ids: string[], codes: string[]): Promise<{ added: number; missing: string[] }> {
		const { found, missing } = await lookup(ids, codes);
		const before = selected.value.length;
		add(found);
		return { added: selected.value.length - before, missing };
	}
	// Takes these samples off the selection (the ones an earlier ?ids= / ?codes= put there).
	function removeMany(ids: string[]): void {
		const drop = new Set(ids);
		selected.value = selected.value.filter((s) => !drop.has(s.id));
		for (const id of drop) dropOverride(id);
	}

	return {
		selected, add, remove, removeMany, clear, copyOverrides, setCopies, resetCopies: dropOverride,
		search, projectId, campaignId, results, total, loading, error, runSearch,
		projects, campaigns, optionsError, loadOptions, loadCampaigns, lookup, resolve,
	};
}
