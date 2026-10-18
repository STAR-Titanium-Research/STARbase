// Create (spec E4, E19, §8): the Create button's action and what follows. On success the records are made, edit mode closes, the map
// reads the first new sample's history (or this one again) and a toast offers the labels. A refusal leaves the draft as it was: the
// reason goes under the button, a refusal by Checks marks every empty required field, and a failed write selects the card it came from.

import { computed, onBeforeUnmount, getCurrentInstance, ref, shallowRef } from 'vue';
import type { useProcessMap } from '../useProcessMap';
import type { EditMode } from './useEditMode';

type ProcessMap = ReturnType<typeof useProcessMap>;

/** How long the toast stays up when nobody closes it. */
export const TOAST_MS = 30_000;

export function useCreate(o: { edit: EditMode; map: ProcessMap; select: (key: string) => void }) {
	const { edit, map } = o;
	const error = ref('');
	/** Mark every empty required field in the forms: after a Create refused by Checks. */
	const showMissing = ref(false);
	const toast = shallowRef<{ sampleIds: string[]; count: number } | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;
	if (getCurrentInstance()) onBeforeUnmount(() => timer && clearTimeout(timer));

	const creating = computed(() => edit.draft.creating.value);
	const empty = computed(() => edit.body.value.items.length === 0);

	function closeToast(): void {
		if (timer) clearTimeout(timer);
		timer = null;
		toast.value = null;
	}

	async function create(): Promise<void> {
		if (creating.value) return;
		error.value = '';
		showMissing.value = false;
		const out = await edit.draft.create();
		if (!out.ok) {
			error.value = out.message;
			if (out.reason === 'checks') showMissing.value = true;
			if (out.reason === 'write') o.select(out.key);
			return;
		}
		const first = out.sampleIds[0];
		toast.value = { sampleIds: out.sampleIds, count: Object.keys(out.created).length };
		if (timer) clearTimeout(timer);
		timer = setTimeout(closeToast, TOAST_MS);
		// Edit mode closes and the first new sample is the focus; with none (work on existing samples) this map is read again.
		const focus = first ? `physical_samples:${first}` : null;
		const here = map.focus.value ? `${map.focus.value.collection}:${map.focus.value.id}` : null;
		edit.writeQuery({ edit: null, ...(focus ? { focus } : {}) });
		if (!focus || focus === here) map.reload();
	}

	return { create, creating, empty, error, showMissing, toast, closeToast };
}
