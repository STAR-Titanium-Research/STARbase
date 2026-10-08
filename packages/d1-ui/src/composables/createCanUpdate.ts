import { ref, watch, type Ref } from 'vue';
import { itemPermissionsUrl, updateAccess } from '../canUpdate';
import { useRequestGate } from './useRequestGate';

interface Api {
	get(url: string, config?: any): Promise<any>;
}

// The state machine of useCanUpdate, with the API passed in so it can be tested without the
// Directus SDK. `canUpdate` is true / false, or null while unknown (not asked yet, being asked, or
// the answer failed). `refresh` forgets the old answer first, so a new route id never shows the
// previous record's answer while its own is on the way, then asks again; a late answer for an
// older id is dropped (latest request wins).
export function createCanUpdate(api: Api, collection: string, id: Ref<string | null | undefined>) {
	const gate = useRequestGate();
	const canUpdate = ref<boolean | null>(null);

	async function refresh() {
		const token = gate.begin();
		canUpdate.value = null;
		const pk = id.value;
		if (!pk) return;
		try {
			const res = await api.get(itemPermissionsUrl(collection, pk));
			if (gate.isCurrent(token)) canUpdate.value = updateAccess(res.data);
		} catch {
			if (gate.isCurrent(token)) canUpdate.value = null;
		}
	}

	watch(id, refresh, { immediate: true });
	return { canUpdate, refresh };
}
