import { useApi, useStores } from '@directus/extensions-sdk';
import type { ParamFieldDef } from '../params';

// The field definitions of a collection (labels, units, conditions) as the signed-in user's app
// sees them. They come from the app's fields store, which is already loaded, so this costs no
// request; if the store is missing (a Directus upgrade renames it) it reads `/fields/<collection>`.
export function useFieldDefs() {
	const stores = useStores();
	const api = useApi();

	async function getFieldDefs(collection: string): Promise<ParamFieldDef[]> {
		if (typeof stores.useFieldsStore === 'function') {
			const defs = stores.useFieldsStore().getFieldsForCollectionSorted(collection) as ParamFieldDef[];
			if (Array.isArray(defs) && defs.length) return defs;
		}
		const { data } = await api.get(`/fields/${collection}`);
		return data.data as ParamFieldDef[];
	}

	return { getFieldDefs };
}
