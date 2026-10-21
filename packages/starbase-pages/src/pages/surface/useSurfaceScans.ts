// What the Surface scans panel reads: the scans of an insert (or of an edge and its insert), as the signed-in user,
// from GET /d1-surface-scan/scans (readable rows in full, locked rows as condition, date and operation).
// One section that fails on its own (a failed reload keeps the rows and says so), a gate so a stale answer from a
// record the person has left is dropped, and a gentle poll while a render is queued or running.

import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { LIST_CAP, useExplorerHost, useRequestGate, useSections } from '@d1/ui';
import { fetchScans } from './scanApi';
import { POLL_MS, shouldPoll, sortScans, type ScanRow } from './scanModel';

export function useSurfaceScans(insertId: Ref<string>, edgeId: Ref<string | null>) {
	const api = useExplorerHost().api;
	const gate = useRequestGate();
	const { section, fill } = useSections(gate);
	const state = section<ScanRow[]>([], true);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let polls = 0;

	const rows = computed(() => state.value.data);
	const capped = ref(false);

	const clearTimer = () => {
		if (timer) clearTimeout(timer);
		timer = null;
	};

	async function load(quiet = false): Promise<void> {
		clearTimer();
		const token = gate.begin();
		if (!quiet) polls = 0;
		await fill(state, token, 'the surface scans', async () => {
			// The endpoint caps its answer at LIST_CAP and does not say whether it cut: a full page is shown as capped.
			const list = await fetchScans(api, { insertId: insertId.value, edgeId: edgeId.value });
			capped.value = list.length >= LIST_CAP;
			return sortScans(list.slice(0, LIST_CAP));
		});
		if (!gate.isCurrent(token)) return;
		if (shouldPoll(state.value.data, polls)) {
			polls++;
			timer = setTimeout(() => void load(true), POLL_MS);
		}
	}

	// A different insert or edge: start from a clean list.
	watch(
		[insertId, edgeId],
		() => {
			state.value = { data: [], loading: true, error: '' };
			capped.value = false;
			void load();
		},
		{ immediate: true },
	);
	onBeforeUnmount(() => {
		clearTimer();
		gate.cancel();
	});

	return { state, rows, capped, reload: () => load() };
}
