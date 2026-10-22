import { computed, ref, watch, type Ref } from 'vue';
import { fetchCanUpdate, offerWrite } from '../canUpdate';
import { useRequestGate } from './useRequestGate';

interface Api {
	get(url: string, config?: any): Promise<any>;
}

// The state machine of useCanUpdate, with the API passed in so it can be tested without the
// Directus SDK. `canUpdate` is true / false, or null while unknown (not asked yet, being asked, or
// the answer failed). `refresh` forgets the old answer first, so a new route id never shows the
// previous record's answer while its own is on the way, then asks again; a late answer for an
// older id is dropped (latest request wins).
// `readOnly` (host.canViewAllAccess, a Lab Viewer): canUpdate is false from the first frame and nothing is asked.
export function createCanUpdate(api: Api, collection: string, id: Ref<string | null | undefined>, readOnly?: Ref<boolean> | null) {
	const gate = useRequestGate();
	const asked = ref<boolean | null>(null);
	const canUpdate = computed(() => offerWrite(readOnly?.value, asked.value));

	async function refresh() {
		const token = gate.begin();
		asked.value = null;
		const pk = id.value;
		if (!pk || readOnly?.value) return;
		const answer = await fetchCanUpdate(api, collection, pk);
		if (gate.isCurrent(token)) asked.value = answer;
	}

	watch([id, () => readOnly?.value], refresh, { immediate: true });
	return { canUpdate, refresh };
}
