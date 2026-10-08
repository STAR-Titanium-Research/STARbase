import { useApi } from '@directus/extensions-sdk';
import type { Ref } from 'vue';
import { createCanUpdate } from './createCanUpdate';

// Whether the signed-in user may update one record, from Directus's item-permissions endpoint.
// `canUpdate` is true / false, or null while unknown (not asked yet, or the answer failed): pages
// show Edit unless it is exactly false, because the server enforces the rule anyway. It asks again
// when `id` changes; call `refresh()` after a save, which can change who may edit (the Owner field).
// A null / empty `id` asks nothing.
export function useCanUpdate(collection: string, id: Ref<string | null | undefined>) {
	return createCanUpdate(useApi(), collection, id);
}
