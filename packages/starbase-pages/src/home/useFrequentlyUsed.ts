import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
	useExplorerHost, RECORD_COLLECTIONS, mergeWithSuggestions, pageEntry, pinEntry, readDismissed, recordEntries, recordRequest, removeEntry, restoreEntry,
	revertPin, splitRecordTarget, suggestedPageEntries, useRequestGate, withoutDismissed, writeDismissed, type UsageEntry,
} from '@d1/ui';

// The Home "Frequently used" lists. GET /d1-usage (core/extensions/d1-usage) says which pages and
// records this user uses most; a page key is named from the kit, and the records' labels are read
// through the normal items API as the user, one request per collection, so a record the user may no
// longer read (or that is gone) simply does not come back and is dropped without a word.
//
// Pin, hide and clear are applied to the lists at once and sent after; a failed one undoes only its
// own entry (clear reloads) and says so on one quiet line. A failure to read the usage at all is one quiet line too.
export const SHOWN = 6;
export const MAX_SHOWN = 15;

type Which = 'pages' | 'records';

export function useFrequentlyUsed() {
	const api = useExplorerHost().api;
	const gate = useRequestGate();
	const pages = ref<UsageEntry[]>([]);
	const records = ref<UsageEntry[]>([]);
	const loading = ref(true);
	// The read failed: the panel says so on one line and shows no lists. `error` is a failed change (pin, hide, clear).
	const loadFailed = ref(false);
	const error = ref('');

	async function loadLabels(items: Array<{ target: string; pinned: boolean }>): Promise<UsageEntry[]> {
		const byCollection = new Map<string, Array<{ target: string; pinned: boolean; id: string }>>();
		for (const it of items) {
			const parts = splitRecordTarget(it.target);
			if (!parts) continue;
			const list = byCollection.get(parts.collection) ?? [];
			list.push({ ...it, id: parts.id });
			byCollection.set(parts.collection, list);
		}
		const found = new Map<string, UsageEntry>();
		await Promise.all([...byCollection].map(async ([collection, used]) => {
			const params = recordRequest(collection, used.map((u) => u.id));
			if (!params) return;
			let rows: any[] = [];
			try {
				rows = (await api.get(`/items/${collection}`, { params })).data?.data ?? [];
			} catch {
				// Forbidden, or the collection is not there for this user: those records are left out.
			}
			for (const e of recordEntries(collection, rows, used)) found.set(e.target, e);
		}));
		// The endpoint's order (pinned first, then by score), whichever request answered first.
		return items.flatMap((it) => found.get(it.target) ?? []);
	}

	async function load() {
		const token = gate.begin();
		try {
			const res = await api.get('/d1-usage');
			const body = res.data ?? {};
			const pageItems: Array<{ target: string; pinned: boolean }> = Array.isArray(body.pages) ? body.pages : [];
			const recordItems: Array<{ target: string; pinned: boolean }> = Array.isArray(body.records) ? body.records : [];
			const recordList = await loadLabels(recordItems.filter((r) => RECORD_COLLECTIONS.includes(String(r.target).split(':')[0])));
			if (!gate.isCurrent(token)) return;
			pages.value = pageItems.flatMap((p) => pageEntry(p.target, !!p.pinned) ?? []);
			records.value = recordList;
			loadFailed.value = false;
		} catch {
			if (!gate.isCurrent(token)) return;
			loadFailed.value = true;
		} finally {
			if (gate.isCurrent(token)) loading.value = false;
		}
	}

	const listOf = (which: Which) => (which === 'pages' ? pages : records);
	const kindOf = (which: Which) => (which === 'pages' ? 'page' : 'record');

	// A failed change undoes only the entry it changed, on the list as it is NOW: another change made
	// (and saved) in the meantime stays. `undo` is that one-entry inverse.
	async function save(send: () => Promise<unknown>, undo: () => void) {
		try {
			await send();
			error.value = '';
		} catch {
			undo();
			error.value = 'That change could not be saved. Try again.';
		}
	}

	function pin(which: Which, entry: UsageEntry) {
		const pinned = !entry.pinned;
		const list = listOf(which);
		const previous = list.value.find((e) => e.target === entry.target) ?? null;
		list.value = pinEntry(list.value, entry, pinned);
		return save(
			() => api.post('/d1-usage/pin', { kind: kindOf(which), target: entry.target, pinned }),
			() => { list.value = revertPin(list.value, entry.target, previous); },
		);
	}

	function hide(which: Which, entry: UsageEntry) {
		const list = listOf(which);
		const { list: rest, index } = removeEntry(list.value, entry.target);
		list.value = rest;
		return save(
			() => api.post('/d1-usage/hide', { kind: kindOf(which), target: entry.target }),
			() => { list.value = restoreEntry(list.value, entry, index); },
		);
	}

	// A suggestion was never used, so there is nothing on the server to hide: dismissing it is this
	// browser's own convenience (localStorage, guarded: without storage it lasts until a reload).
	const dismissed = ref<Set<string>>(readDismissed());
	function dismissSuggestion(entry: UsageEntry) {
		const next = new Set(dismissed.value).add(entry.target);
		dismissed.value = next;
		writeDismissed(next);
	}

	// Clear keeps the pins (the endpoint drops the rest and zeroes the pinned scores). The lists are
	// emptied at once, and the answer is read back from the server either way: a failure puts back
	// what the server still has (not a snapshot), and a read that was already in flight is dropped
	// (load() starts a newer one) so it cannot bring the old history back.
	async function clear() {
		gate.begin();
		pages.value = pages.value.filter((e) => e.pinned);
		records.value = records.value.filter((e) => e.pinned);
		let failed = false;
		try {
			await api.post('/d1-usage/clear');
		} catch {
			failed = true;
		}
		await load();
		if (failed && !loadFailed.value) error.value = 'Your history could not be cleared. Try again.';
	}

	// Pages: the user's own, then suggestions (not dismissed here) while there are fewer than SHOWN.
	const pageList = computed(() => mergeWithSuggestions(pages.value, withoutDismissed(suggestedPageEntries(), dismissed.value), SHOWN).slice(0, MAX_SHOWN));
	const recordList = computed(() => records.value.slice(0, MAX_SHOWN));

	onMounted(load);
	onBeforeUnmount(() => gate.cancel());

	return { pageList, recordList, loading, loadFailed, error, pin, hide, dismissSuggestion, clear };
}
