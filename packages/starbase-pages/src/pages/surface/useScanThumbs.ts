// Thumbnails of the scans a panel lists. The browser's <img> cannot be trusted to send the session to every host,
// so each thumbnail is read through the host's API client as a Blob and shown from an object URL (STARbase's CSP
// allows img-src blob:). A few at a time; a thumbnail that fails is not retried until the list is reloaded.

import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import { useExplorerHost } from '@d1/ui';
import { fetchThumb } from './scanApi';
import { canOpenScan, type ScanRow } from './scanModel';

const PARALLEL = 3;

/** The rows that have a finished render and no thumbnail yet, and were not tried. Pure. */
export function thumbsToLoad(rows: ScanRow[], have: ReadonlySet<string>, tried: ReadonlySet<string>): string[] {
	return rows.filter((r) => canOpenScan(r) && r.id && !have.has(r.id) && !tried.has(r.id)).map((r) => r.id);
}

export function useScanThumbs(rows: Ref<ScanRow[]>) {
	const api = useExplorerHost().api;
	const urls = ref<Record<string, string>>({});
	const tried = new Set<string>();
	const inFlight = new Set<string>();
	let running = 0;
	let disposed = false;

	function pump(): void {
		const have = new Set(Object.keys(urls.value));
		const queued = new Set(inFlight);
		for (const id of thumbsToLoad(rows.value, have, tried)) {
			if (running >= PARALLEL) return;
			if (queued.has(id)) continue;
			void load(id);
		}
	}

	async function load(id: string): Promise<void> {
		running++;
		inFlight.add(id);
		try {
			const blob = await fetchThumb(api, id);
			if (disposed || !rows.value.some((r) => r.id === id && canOpenScan(r))) return; // gone, or being rendered again
			urls.value = { ...urls.value, [id]: URL.createObjectURL(blob) };
		} catch {
			tried.add(id); // the row shows its placeholder; a reload of the list tries again
		} finally {
			running--;
			inFlight.delete(id);
			if (!disposed) pump();
		}
	}

	// A scan that left the list (or went back to rendering) gives its object URL back.
	watch(
		rows,
		(list) => {
			const live = new Set(list.filter(canOpenScan).map((r) => r.id));
			const next: Record<string, string> = {};
			for (const [id, url] of Object.entries(urls.value)) {
				if (live.has(id)) next[id] = url;
				else URL.revokeObjectURL(url);
			}
			if (Object.keys(next).length !== Object.keys(urls.value).length) urls.value = next;
			pump();
		},
		{ immediate: true },
	);

	/** Forget failures, so the next list load tries those thumbnails again. */
	const retry = () => {
		tried.clear();
		pump();
	};

	onBeforeUnmount(() => {
		disposed = true;
		for (const url of Object.values(urls.value)) URL.revokeObjectURL(url);
		urls.value = {};
	});

	return { urls, retry };
}
