import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
	useExplorerHost, usePins, RECORD_COLLECTIONS, mergeWithSuggestions, pageEntry, readDismissed, recordEntries, recordRequest, removeEntry, restoreEntry,
	splitRecordTarget, suggestedPageEntries, useRequestGate, withoutDismissed, withoutPinned, writeDismissed, type UsageEntry,
} from '@d1/ui';

// The Home "Frequently used" lists. GET /d1-usage (core/extensions/d1-usage) says which pages and
// records this user uses most; a page key is named from the kit, and the records' labels are read
// through the normal items API as the user, one request per collection, so a record the user may no
// longer read (or that is gone) simply does not come back and is dropped without a word.
//
// Pins live in the sidebar (the kit's shared usePins state), and the endpoint leaves pinned rows out, so
// these lists only ever hold what is not pinned. Pinning a row calls usePins().toggle: the pin is added
// to the shared state at once, which takes the row off the list (the lists are filtered by it), and a
// failed save rolls the pin back, which puts the row back in its place (usePins says so in the sidebar).
//
// Hide and clear are applied to the lists at once and sent after; a failed one undoes only its own entry
// (clear reloads) and says so on one quiet line. A failure to read the usage at all is one quiet line too.
export const SHOWN = 6;
export const MAX_SHOWN = 15;

type Which = 'pages' | 'records';

export function useFrequentlyUsed() {
	const api = useExplorerHost().api;
	const pinsState = usePins();
	const gate = useRequestGate();
	const pages = ref<UsageEntry[]>([]);
	const records = ref<UsageEntry[]>([]);
	const loading = ref(true);
	// The read failed: the panel says so on one line and shows no lists. `error` is a failed change (pin, hide, clear).
	const loadFailed = ref(false);
	const error = ref('');

	async function loadLabels(items: Array<{ target: string; pinned?: boolean }>): Promise<UsageEntry[]> {
		const byCollection = new Map<string, Array<{ target: string; pinned: boolean; id: string }>>();
		for (const it of items) {
			const parts = splitRecordTarget(it.target);
			if (!parts) continue;
			const list = byCollection.get(parts.collection) ?? [];
			list.push({ pinned: false, target: it.target, id: parts.id });
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
		// The endpoint's order (by score), whichever request answered first.
		return items.flatMap((it) => found.get(it.target) ?? []);
	}

	async function load() {
		const token = gate.begin();
		try {
			const res = await api.get('/d1-usage');
			const body = res.data ?? {};
			const pageItems: Array<{ target: string }> = Array.isArray(body.pages) ? body.pages : [];
			const recordItems: Array<{ target: string }> = Array.isArray(body.records) ? body.records : [];
			const recordList = await loadLabels(recordItems.filter((r) => RECORD_COLLECTIONS.includes(String(r.target).split(':')[0])));
			if (!gate.isCurrent(token)) return;
			pages.value = pageItems.flatMap((p) => pageEntry(p.target, false) ?? []);
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

	// The row leaves the list through the shared pins state (see the top of this file); there is no
	// local request and nothing to undo here.
	function pin(which: Which, entry: UsageEntry) {
		return pinsState.toggle({ kind: kindOf(which), target: entry.target });
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

	// Clear drops the history of everything that is not pinned (the endpoint keeps the pins and zeroes
	// their scores), which is all these lists hold, so they are emptied at once; and the answer is read back from the server either way: a failure puts back
	// what the server still has (not a snapshot), and a read that was already in flight is dropped
	// (load() starts a newer one) so it cannot bring the old history back.
	async function clear() {
		gate.begin();
		pages.value = [];
		records.value = [];
		let failed = false;
		try {
			await api.post('/d1-usage/clear');
		} catch {
			failed = true;
		}
		await load();
		if (failed && !loadFailed.value) error.value = 'Your history could not be cleared. Try again.';
	}

	// Pages: the user's own, then suggestions (not dismissed here, not pinned) while there are fewer than SHOWN.
	// Pinned rows are left out of both lists, as the shared pins state says (a suggestion has no row on
	// the server, so only this filter keeps a pinned one off the list).
	const isPinned = pinsState.isPinned;
	const pageList = computed(() => mergeWithSuggestions(
		withoutPinned(pages.value, 'page', isPinned),
		withoutPinned(withoutDismissed(suggestedPageEntries(), dismissed.value), 'page', isPinned),
		SHOWN,
	).slice(0, MAX_SHOWN));
	const recordList = computed(() => withoutPinned(records.value, 'record', isPinned).slice(0, MAX_SHOWN));

	onMounted(load);
	onBeforeUnmount(() => gate.cancel());

	return { pageList, recordList, loading, loadFailed, error, pin, hide, dismissSuggestion, clear };
}
