import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useApi } from '@directus/extensions-sdk';
import {
	RECORD_COLLECTIONS, mergeWithSuggestions, pageEntry, recordEntries, recordRequest, splitRecordTarget, suggestedPageEntries,
	useRequestGate, type UsageEntry,
} from '@d1/ui';

// The Home "Frequently used" lists. GET /d1-usage (core/extensions/d1-usage) says which pages and
// records this user uses most; a page key is named from the kit, and the records' labels are read
// through the normal items API as the user, one request per collection, so a record the user may no
// longer read (or that is gone) simply does not come back and is dropped without a word.
//
// Pin, hide and clear are applied to the lists at once and sent after; a failed one puts the lists
// back and says so on one quiet line. A failure to read the usage at all is one quiet line too.
export const SHOWN = 6;
export const MAX_SHOWN = 15;

type Which = 'pages' | 'records';
const sortPinned = (list: UsageEntry[]) => [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned));

export function useFrequentlyUsed() {
	const api = useApi();
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

	// Runs `change` on the list at once, then `send`; if the send fails the list goes back as it was.
	async function apply(which: Which, change: (list: UsageEntry[]) => UsageEntry[], send: () => Promise<unknown>) {
		const list = listOf(which);
		const before = list.value;
		list.value = change(before);
		try {
			await send();
			error.value = '';
		} catch {
			list.value = before;
			error.value = 'That change could not be saved. Try again.';
		}
	}

	function pin(which: Which, entry: UsageEntry) {
		const pinned = !entry.pinned;
		return apply(
			which,
			(list) => {
				const has = list.some((e) => e.target === entry.target);
				const next = has ? list.map((e) => (e.target === entry.target ? { ...e, pinned } : e)) : [...list, { ...entry, pinned, suggested: undefined }];
				return sortPinned(next);
			},
			() => api.post('/d1-usage/pin', { kind: kindOf(which), target: entry.target, pinned }),
		);
	}

	function hide(which: Which, entry: UsageEntry) {
		return apply(which, (list) => list.filter((e) => e.target !== entry.target), () => api.post('/d1-usage/hide', { kind: kindOf(which), target: entry.target }));
	}

	// Clear keeps the pins (the endpoint drops the rest and zeroes the pinned scores).
	async function clear() {
		const beforePages = pages.value;
		const beforeRecords = records.value;
		pages.value = pages.value.filter((e) => e.pinned);
		records.value = records.value.filter((e) => e.pinned);
		try {
			await api.post('/d1-usage/clear');
			error.value = '';
		} catch {
			pages.value = beforePages;
			records.value = beforeRecords;
			error.value = 'Your history could not be cleared. Try again.';
		}
	}

	// Pages: the user's own, then suggestions while there are fewer than SHOWN (flagged `suggested`).
	const pageList = computed(() => mergeWithSuggestions(pages.value, suggestedPageEntries(), SHOWN).slice(0, MAX_SHOWN));
	const recordList = computed(() => records.value.slice(0, MAX_SHOWN));

	onMounted(load);
	onBeforeUnmount(() => gate.cancel());

	return { pageList, recordList, loading, loadFailed, error, pin, hide, clear };
}
