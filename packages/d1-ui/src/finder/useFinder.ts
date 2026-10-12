import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Ref } from 'vue';
import type { ExplorerHost } from '../host';
import type { VisibleNav } from '../nav/navConfig';
import { useRequestGate } from '../composables/useRequestGate';
import { isSearchable, localHits, mergeHits, sourceParams, toHits, visibleSources } from './finder';
import type { FinderHit } from './finder';
import { isScanComplete, isScanStarted, resolveLabel } from './scan';
import type { ScanOutcome } from './scan';

// The finder's state: the query, and the hits for it. Pages and saved views are matched in the
// browser on every keystroke; the records are asked of the server once typing pauses (200 ms),
// one GET /items/<collection> per collection the user can read, all at once.

export const FINDER_DEBOUNCE_MS = 200;
// A USB scanner types a whole label in a few milliseconds, one key at a time. Once the text has been
// still for this long it is a finished scan, so it is read without the user pressing anything.
export const SCAN_IDLE_MS = 250;

// What the finder shows while the query is a scanned D1 label instead of a search.
export type FinderScan = { status: 'reading' } | { status: 'resolving' } | { status: 'done'; outcome: ScanOutcome };

export interface FinderOptions {
	// A scanned label's sample was found: the route to open.
	onOpen?: (to: string) => void;
	// A scan ended without opening a sample (not found, a card to confirm, not a label). The box still
	// holds the scanned text; the host selects it so the next scan replaces it instead of being added to it.
	onSettled?: () => void;
}

export function useFinder(host: ExplorerHost, nav: Ref<VisibleNav>, visible: Ref<Set<string> | null>, options: FinderOptions = {}) {
	const query = ref('');
	const loading = ref(false);
	// What the server said for one query. A result only counts for the query it answered.
	const remote = ref<{ q: string; groups: FinderHit[][] } | null>(null);
	const gate = useRequestGate();
	const scan = ref<FinderScan | null>(null);
	const scanning = computed(() => isScanStarted(query.value));
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

	// The query is a scanned label: find its sample. Nothing here is a search, so no hits are asked for.
	async function settleScan(): Promise<void> {
		stop();
		const token = gate.begin();
		scan.value = { status: 'resolving' };
		const outcome = await resolveLabel(host.api, query.value);
		if (!gate.isCurrent(token)) return; // edited meanwhile, or closed
		scan.value = { status: 'done', outcome };
		if (outcome.kind === 'open') options.onOpen?.(outcome.to);
		else options.onSettled?.();
	}

	// Read the label now, without waiting for the scanner to go quiet (a paste is already whole).
	function readScanNow(): void {
		if (scanning.value) void settleScan();
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
			if (isScanStarted(q)) {
				remote.value = null;
				loading.value = false;
				scan.value = { status: 'reading' };
				// Only a label that has its code line and a line break after it is read on a pause; a bare
				// header or half a code line waits for Enter (a pause mid-scan must not read half a label).
				timer = setTimeout(() => { if (isScanComplete(q)) void settleScan(); }, SCAN_IDLE_MS);
				return;
			}
			scan.value = null;
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

	// The sidebar's lists may still be loading when the finder opens (Ctrl K right after the page
	// loads): a query typed meanwhile was answered with no sources, and that empty answer must not
	// stay. When the readable collections arrive (or change), ask again for the current query.
	watch(visible, (v) => {
		const q = query.value;
		if (!v || !isSearchable(q) || isScanStarted(q)) return;
		stop();
		loading.value = true;
		void run(q);
	});

	const hits = computed<FinderHit[]>(() => {
		const q = query.value;
		if (isScanStarted(q)) return [];
		const answered = remote.value && remote.value.q === q ? remote.value.groups : [];
		return mergeHits(q, [localHits(q, nav.value), ...answered]);
	});

	onBeforeUnmount(stop);

	return { query, hits, loading, scan, scanning, readScanNow, searchable: computed(() => isSearchable(query.value)) };
}
