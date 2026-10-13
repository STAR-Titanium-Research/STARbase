import { ref } from 'vue';
import type { Ref } from 'vue';
import type { ExplorerHost } from '../host';
import { useExplorerHost } from '../host';
import { recordEntries, recordRequest, splitRecordTarget } from '../usage';
import { pinKey } from './sidebarModel';
import type { PinRef, RecordLabel } from './sidebarModel';

// The person's pins and sidebar preferences (spec decision 5): what is pinned and in what order,
// the codes of the pinned records, and the three prefs. GET /d1-usage/nav answers once per app
// session; the state lives in module scope, keyed by the host (like useExplorerNav), so the
// sidebar, Home's panel, the header toggle and Settings all see the same pins.
//
// A change is applied at once and sent after; a failed one is undone (only that change, on the
// list as it is now) and says so on a quiet notice that clears itself. A 409 on reorder means
// another tab changed the pins: the server's list is read back instead, with no notice.

export interface NavPrefs {
	sidebarCollapsed: boolean;
	autoCollapse: boolean;
	theme: 'system' | 'light' | 'dark';
}

export const DEFAULT_PREFS: NavPrefs = { sidebarCollapsed: false, autoCollapse: true, theme: 'system' };

export interface PinsState {
	pins: Ref<PinRef[]>;
	// The code (and route) of each pinned record, keyed by its pin target ("<collection>:<id>"). A
	// record whose request failed or whose row did not come back is absent: it is unavailable.
	records: Ref<Map<string, RecordLabel>>;
	prefs: Ref<NavPrefs>;
	loaded: Ref<boolean>;
	// Only the /nav request failing sets this; a record collection that fails just leaves its codes out.
	loadFailed: Ref<boolean>;
	notice: Ref<string | null>;
	isPinned(p: PinRef): boolean;
	toggle(p: PinRef): Promise<void>;
	reorder(next: PinRef[]): Promise<void>;
	setPref<K extends keyof NavPrefs>(k: K, v: NavPrefs[K]): Promise<void>;
	resetPins(): Promise<void>;
	refresh(): Promise<void>;
}

export const PINS_FAILED = "Couldn't save your pins. Try again.";
export const PREFS_FAILED = "Couldn't save. Try again.";
export const NOTICE_MS = 6000;

const KINDS = ['page', 'view', 'record'];
const THEMES = ['system', 'light', 'dark'];

function cleanPins(raw: unknown): PinRef[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((p) => (p && KINDS.includes(p.kind) && typeof p.target === 'string' ? [{ kind: p.kind, target: p.target } as PinRef] : []));
}

// What was stored, with the defaults under it; a value of the wrong type counts as not stored.
function cleanPrefs(raw: any): NavPrefs {
	const stored = raw && typeof raw === 'object' ? raw : {};
	return {
		sidebarCollapsed: typeof stored.sidebarCollapsed === 'boolean' ? stored.sidebarCollapsed : DEFAULT_PREFS.sidebarCollapsed,
		autoCollapse: typeof stored.autoCollapse === 'boolean' ? stored.autoCollapse : DEFAULT_PREFS.autoCollapse,
		theme: THEMES.includes(stored.theme) ? stored.theme : DEFAULT_PREFS.theme,
	};
}

// The codes of these record pins, one items request per collection, read as the user: a collection
// that fails (403, ...) or a row that does not come back is left out without a word.
async function fetchRecordLabels(host: ExplorerHost, pins: PinRef[]): Promise<Map<string, RecordLabel>> {
	const byCollection = new Map<string, Array<{ target: string; pinned: boolean; id: string }>>();
	for (const p of pins) {
		if (p.kind !== 'record') continue;
		const parts = splitRecordTarget(p.target);
		if (!parts) continue;
		const list = byCollection.get(parts.collection) ?? [];
		list.push({ target: p.target, pinned: true, id: parts.id });
		byCollection.set(parts.collection, list);
	}
	const found = new Map<string, RecordLabel>();
	await Promise.all([...byCollection].map(async ([collection, used]) => {
		const params = recordRequest(collection, used.map((u) => u.id));
		if (!params) return;
		try {
			const res = await host.api.get(`/items/${collection}`, { params });
			for (const e of recordEntries(collection, res.data?.data ?? [], used)) found.set(e.target, { code: e.label, to: e.to });
		} catch {
			// Unavailable: these records stay out of `records`.
		}
	}));
	return found;
}

let states = new WeakMap<ExplorerHost, PinsState>();

// Test-only: forget every host's state, so each test starts from a first load.
export function __resetPinsForTests(): void {
	states = new WeakMap();
}

export function usePins(): PinsState {
	const host = useExplorerHost();
	const existing = states.get(host);
	if (existing) return existing;

	const pins = ref<PinRef[]>([]);
	const records = ref<Map<string, RecordLabel>>(new Map());
	const prefs = ref<NavPrefs>({ ...DEFAULT_PREFS });
	const loaded = ref(false);
	const loadFailed = ref(false);
	const notice = ref<string | null>(null);

	let noticeTimer: ReturnType<typeof setTimeout> | null = null;
	function say(text: string): void {
		notice.value = text;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => { notice.value = null; noticeTimer = null; }, NOTICE_MS);
	}

	// A second refresh while one runs (Retry clicked twice, a component mounting during the first load) joins it.
	let inFlight: Promise<void> | null = null;
	function refresh(): Promise<void> {
		if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
		return inFlight;
	}

	async function load(): Promise<void> {
		let body: any;
		try {
			body = (await host.api.get('/d1-usage/nav')).data ?? {};
		} catch {
			// Keep what an earlier load showed; on a first load that is no pins.
			loadFailed.value = true;
			return;
		}
		const next = cleanPins(body.pins);
		const labels = await fetchRecordLabels(host, next);
		pins.value = next;
		prefs.value = cleanPrefs(body.prefs);
		records.value = labels;
		loaded.value = true;
		loadFailed.value = false;
	}

	// Writes go one at a time, in the order they were made: a reorder sent while a pin is still on
	// its way would otherwise reach the server first and be refused as a different set of pins.
	let queue: Promise<unknown> | null = null;
	function enqueue<T>(job: () => Promise<T>): Promise<T> {
		// Nothing ahead: start now (the request is on its way before the caller's next line).
		const run = queue ? queue.then(job) : job();
		const tail: Promise<unknown> = run.catch(() => {}).finally(() => { if (queue === tail) queue = null; });
		queue = tail;
		return run;
	}

	const statusOf = (e: any): number | undefined => e?.response?.status;

	const isPinned = (p: PinRef): boolean => pins.value.some((q) => pinKey(q) === pinKey(p));

	async function toggle(p: PinRef): Promise<void> {
		const ref_: PinRef = { kind: p.kind, target: p.target };
		const key = pinKey(ref_);
		const index = pins.value.findIndex((q) => pinKey(q) === key);
		orderChange++;
		const pinning = index < 0;
		pins.value = pinning ? [...pins.value, ref_] : pins.value.filter((_, i) => i !== index);
		if (pinning && ref_.kind === 'record' && !records.value.has(ref_.target)) {
			void fetchRecordLabels(host, [ref_]).then((found) => {
				if (found.size) records.value = new Map([...records.value, ...found]);
			});
		}
		try {
			await enqueue(() => host.api.post('/d1-usage/pin', { kind: ref_.kind, target: ref_.target, pinned: pinning }));
		} catch {
			// Undo only this change, on the list as it is now.
			if (pinning) {
				pins.value = pins.value.filter((q) => pinKey(q) !== key);
			} else if (!isPinned(ref_)) {
				const at = Math.min(index, pins.value.length);
				pins.value = [...pins.value.slice(0, at), ref_, ...pins.value.slice(at)];
			}
			say(PINS_FAILED);
		}
	}

	// Counts every change to the list, so an undo knows whether it is still the latest.
	let orderChange = 0;

	async function reorder(next: PinRef[]): Promise<void> {
		const previous = pins.value;
		const items = next.map((p) => ({ kind: p.kind, target: p.target }));
		const mine = ++orderChange;
		pins.value = items;
		try {
			await enqueue(() => host.api.post('/d1-usage/pin-order', { items }));
		} catch (e) {
			if (statusOf(e) === 409) {
				await refresh();
				return;
			}
			// Only if nothing reordered or pinned since.
			if (mine === orderChange) pins.value = previous;
			say(PINS_FAILED);
		}
	}

	async function setPref<K extends keyof NavPrefs>(k: K, v: NavPrefs[K]): Promise<void> {
		const previous = prefs.value[k];
		prefs.value = { ...prefs.value, [k]: v };
		try {
			await enqueue(() => host.api.post('/d1-usage/prefs', { [k]: v }));
		} catch {
			// Only if nothing changed this pref since.
			if (prefs.value[k] === v) prefs.value = { ...prefs.value, [k]: previous };
			say(PREFS_FAILED);
		}
	}

	async function resetPins(): Promise<void> {
		try {
			await enqueue(() => host.api.post('/d1-usage/pins/reset'));
		} catch {
			say(PINS_FAILED);
			return;
		}
		await refresh();
	}

	const state: PinsState = { pins, records, prefs, loaded, loadFailed, notice, isPinned, toggle, reorder, setPref, resetPins, refresh };
	states.set(host, state);
	void refresh();
	return state;
}
