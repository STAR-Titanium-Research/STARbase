import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { ExplorerHost } from '../host';
import type { VisibleNav } from '../nav/navConfig';
import { useRequestGate } from '../composables/useRequestGate';
import { isSearchable, localHits, mergeHits, sourceParams, toHits, visibleSources } from './finder';
import type { FinderHit } from './finder';

// The finder's state: the query, and the hits for it. Pages and saved views are matched in the
// browser on every keystroke; the records are asked of the server once typing pauses (200 ms),
// one GET /items/<collection> per collection the user can read, all at once.

export const FINDER_DEBOUNCE_MS = 200;

export function useFinder(host: ExplorerHost, nav: Ref<VisibleNav>, visible: Ref<Set<string> | null>) {
	const query = ref('');
	const loading = ref(false);
	// What the server said for one query. A result only counts for the query it answered.
	const remote = ref<{ q: string; groups: FinderHit[][] } | null>(null);
	const gate = useRequestGate();
	let timer: ReturnType<typeof setTimeout> | undefined;

	// One source. A failure (a 403 when the user may not read a collection the label expands into,
	// the network) drops this group only; the others still show.
	async function search(src: ReturnType<typeof visibleSources>[number], q: string): Promise<FinderHit[]> {
		try {
			const res = await host.api.get(`/items/${src.collection}`, { params: sourceParams(src, q) });
			const rows = res.data?.data;
			return Array.isArray(rows) ? toHits(src, q, rows) : [];
		} catch {
			return [];
		}
	}

	async function run(q: string): Promise<void> {
		const token = gate.begin();
		const groups = await Promise.all(visibleSources(visible.value).map((src) => search(src, q)));
		if (!gate.isCurrent(token)) return; // typed on, or closed
		remote.value = { q, groups };
		loading.value = false;
	}

	function stop(): void {
		clearTimeout(timer);
		timer = undefined;
		gate.cancel();
	}

	// Sync, so the pending state is never a tick behind the input.
	watch(
		query,
		(q) => {
			stop();
			if (!isSearchable(q)) {
				remote.value = null;
				loading.value = false;
				return;
			}
			loading.value = true;
			timer = setTimeout(() => void run(q), FINDER_DEBOUNCE_MS);
		},
		{ flush: 'sync' },
	);

	const hits = computed<FinderHit[]>(() => {
		const q = query.value;
		const answered = remote.value && remote.value.q === q ? remote.value.groups : [];
		return mergeHits(q, [localHits(q, nav.value), ...answered]);
	});

	onBeforeUnmount(stop);

	return { query, hits, loading, searchable: computed(() => isSearchable(query.value)) };
}
