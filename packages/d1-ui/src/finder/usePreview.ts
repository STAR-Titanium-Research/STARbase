import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { Ref } from 'vue';
import type { HostApi } from '../host';
import { asRecord } from '../format';
import { useRequestGate } from '../composables/useRequestGate';
import type { FinderHit } from './finder';
import { buildCard, instantCard, previewKey, previewRequest } from './previewCard';
import type { PreviewCard } from './previewCard';

// The finder's preview pane state: for the active record hit, one read of the record with only the card's fields, started once the active row has stopped
// changing. It never touches the list: the finder shows its rows whatever this does.
//
// - idle: nothing to show yet (no record hit, the pane is off, or the active row changed less than PREVIEW_SETTLE_MS ago). Stepping fast through the rows
//   therefore asks the server for nothing.
// - loading: the card's instant part (label, kind, detail, matched-in line, all from the hit) shows while the record is read.
// - ready: the finished card. A record read once is kept (per `collection:id`) for the life of the finder, so stepping back to it costs nothing and shows
//   at once.
// - unavailable: the read failed (a 403, a field the role may not read, the network). The row still opens; only the card is missing.
//
// A change of the active record aborts the read in flight, and a late answer for a record that is no longer the active one is dropped.

export const PREVIEW_SETTLE_MS = 120;

export type PreviewState = 'idle' | 'loading' | 'ready' | 'unavailable';

export function usePreview(hit: Ref<FinderHit | null | undefined>, api: Pick<HostApi, 'get'>, enabled: Ref<boolean>, settleMs = PREVIEW_SETTLE_MS) {
	const state = ref<PreviewState>('idle');
	// The record the state is about (not the hit: a streamed answer can hand over a new hit object for the same record, and that must not restart anything).
	const shownKey = ref<string | null>(null);
	const cache = new Map<string, unknown>();
	const gate = useRequestGate();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | undefined;
	const row = shallowRef<unknown>(null);

	// The key of the record to show a card for, or null (also while the pane is off, so nothing is asked for a pane nobody sees).
	const key = computed(() => (enabled.value ? previewKey(hit.value) : null));

	function cancel(): void {
		clearTimeout(timer);
		timer = undefined;
		gate.cancel();
		controller?.abort();
		controller = undefined;
	}

	async function load(k: string, h: FinderHit): Promise<void> {
		const request = previewRequest(h.record!.collection, h.record!.id);
		if (!request) return;
		const token = gate.begin();
		controller = new AbortController();
		try {
			const res = await api.get(request.path, { params: { fields: request.fields }, signal: controller.signal });
			if (!gate.isCurrent(token)) return; // another row became active, or the finder closed
			const data = asRecord(res.data?.data);
			if (!data) {
				state.value = 'unavailable';
				return;
			}
			cache.set(k, data);
			row.value = data;
			state.value = 'ready';
		} catch {
			// An aborted or superseded read is not a failure of this card.
			if (gate.isCurrent(token)) state.value = 'unavailable';
		}
	}

	watch(
		key,
		(k) => {
			cancel();
			shownKey.value = k;
			row.value = null;
			if (k === null) {
				state.value = 'idle';
				return;
			}
			if (cache.has(k)) {
				row.value = cache.get(k);
				state.value = 'ready';
				return;
			}
			state.value = 'idle';
			timer = setTimeout(() => {
				timer = undefined;
				const h = hit.value;
				// The hit is read when the timer fires: it is the same record (the key has not changed) with whatever the list knows of it by now.
				if (!h || previewKey(h) !== k) return;
				state.value = 'loading';
				void load(k, h);
			}, settleMs);
		},
		// After the render, not in the middle of the change: Finder.vue re-points the active row (a watcher on the hits) once a streamed answer has landed, and a
		// key read in between would see another record, abort the read in flight and start the wait again.
		{ immediate: true, flush: 'post' },
	);

	const card = computed<PreviewCard | null>(() => {
		const h = hit.value;
		if (!h || state.value === 'idle' || previewKey(h) !== shownKey.value) return null;
		return state.value === 'ready' ? buildCard(h, row.value) : instantCard(h);
	});

	onBeforeUnmount(cancel);

	return { state, card };
}
