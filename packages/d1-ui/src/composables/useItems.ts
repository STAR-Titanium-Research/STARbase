import { useApi } from '@directus/extensions-sdk';

// Thin wrapper over the Directus /items API, as the signed-in user, so permissions apply.
// (Not the SDK's own `useItems` composable, which is a list-layout helper.)
export function useItems() {
	const api = useApi();

	async function getItems(collection: string, params: Record<string, unknown> = {}): Promise<any[]> {
		const { data } = await api.get(`/items/${collection}`, { params });
		return data.data as any[];
	}

	async function getItem(collection: string, id: string, params: Record<string, unknown> = {}): Promise<any> {
		const { data } = await api.get(`/items/${collection}/${id}`, { params });
		return data.data;
	}

	return { getItems, getItem };
}
