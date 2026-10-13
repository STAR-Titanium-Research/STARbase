import { useExplorerHost } from '../host';
import type { ParamFieldDef } from '../params';

// The field definitions of a collection (labels, units, conditions) as the signed-in user's app sees
// them; the host knows where they come from (the Directus app's fields store, or GET /fields).
export function useFieldDefs() {
	const host = useExplorerHost();
	async function getFieldDefs(collection: string): Promise<ParamFieldDef[]> {
		return (await host.fieldsFor(collection)) as unknown as ParamFieldDef[];
	}
	return { getFieldDefs };
}
