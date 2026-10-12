import { computed, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import { classifyTemplates, errorText, pickTemplate, type BrokenTemplate, type LabelTemplate } from '@d1/ui';

// The label_templates the signed-in user may read, as the page's picker shows them. A row that cannot be
// read as a template is listed as broken (disabled, with the reason) and never blanks the picker.
const STORAGE_KEY = 'd1-labels-template';

// localStorage can throw (private window, blocked site data): the page works without it.
function remembered(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}
function remember(id: string | null): void {
	try {
		if (id) localStorage.setItem(STORAGE_KEY, id);
		else localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* not remembered */
	}
}

export function useLabelTemplates() {
	const api = useApi();
	const templates = ref<LabelTemplate[]>([]);
	const broken = ref<BrokenTemplate[]>([]);
	const loading = ref(false);
	const error = ref('');
	const selectedId = ref<string | null>(null);
	const selected = computed(() => templates.value.find((t) => t.id === selectedId.value) ?? null);

	// `choose`: the id to show afterwards (a template just saved); else the one on screen, the remembered one,
	// the default, the first that prints.
	async function load(choose?: string | null): Promise<void> {
		loading.value = true;
		error.value = '';
		try {
			const res = await api.get('/items/label_templates', { params: { fields: ['*'], sort: ['name'], limit: -1 } });
			const out = classifyTemplates((res.data?.data ?? []) as Record<string, unknown>[]);
			templates.value = out.templates;
			broken.value = out.broken;
			const keep = choose ?? selectedId.value ?? remembered();
			const pick = out.templates.find((t) => t.id === choose) ?? pickTemplate(out.templates, keep);
			selectedId.value = pick?.id ?? null;
		} catch (e) {
			error.value = `Could not load the label templates: ${errorText(e)}`;
		} finally {
			loading.value = false;
		}
	}

	function select(id: string | null): void {
		selectedId.value = id;
		remember(id);
	}

	return { templates, broken, loading, error, selectedId, selected, load, select };
}
