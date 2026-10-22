import { ref, watch } from 'vue';
import { useRequestGate, type HostApi } from '@d1/ui';
import { loadSiblings, type FoundFile } from './inboxApi';
import { SIBLINGS_SHOWN } from './linkedModel';

/**
 * The other pictures linked to the same record as one file (GET /d1-inbox/siblings), for as long as the component lives. `id` is the file's candidate id, or null
 * when it has no siblings to look for (hasSiblings); it is asked again when `id` changes, and the latest answer wins. A failed call is no siblings: the card
 * above the strip does not depend on it, so there is nothing to say.
 */
export function useSiblings(api: HostApi, id: () => string | null) {
	const gate = useRequestGate();
	const rows = ref<FoundFile[]>([]);
	const total = ref(0);
	const loading = ref(false);

	async function load(): Promise<void> {
		const file = id();
		const token = gate.begin();
		rows.value = [];
		total.value = 0;
		loading.value = !!file;
		if (!file) return;
		try {
			const page = await loadSiblings(api, file, SIBLINGS_SHOWN);
			if (!gate.isCurrent(token)) return;
			rows.value = page.rows;
			total.value = page.total;
		} catch {
			// no strip
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	watch(id, () => void load(), { immediate: true });
	return { rows, total, loading, reload: load };
}
