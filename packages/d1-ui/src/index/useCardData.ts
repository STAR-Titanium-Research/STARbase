// What a designed card (the campaigns' counts) shows beyond the row, for the rows on screen, in Cards layout only.
// A failure leaves the map empty: the cards then say the numbers are unavailable. A newer set of rows drops a
// slow answer for the older one.
import { getCurrentInstance, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { ExplorerHost } from '../host';
import { useRequestGate } from '../composables/useRequestGate';
import type { ListView } from './listPrefs';

type Loader = (host: ExplorerHost, rows: any[]) => Promise<ReadonlyMap<string, unknown>>;

export function useCardData(host: ExplorerHost, load: () => Loader | undefined, view: () => ListView, rows: Ref<any[]>) {
	const cardMap = ref<ReadonlyMap<string, unknown> | null>(null);
	const cardLoading = ref(false);
	const gate = useRequestGate();
	watch(
		[view, rows],
		async ([v, list]) => {
			const token = gate.begin();
			cardMap.value = null;
			const loader = load();
			if (v !== 'cards' || !loader || !list.length) {
				cardLoading.value = false;
				return;
			}
			cardLoading.value = true;
			let data: ReadonlyMap<string, unknown> = new Map();
			try {
				data = await loader(host, list);
			} catch {
				// no numbers, not an error page
			}
			if (!gate.isCurrent(token)) return;
			cardMap.value = data;
			cardLoading.value = false;
		},
		{ immediate: true },
	);
	if (getCurrentInstance()) onBeforeUnmount(() => gate.cancel());
	return { cardMap, cardLoading };
}
