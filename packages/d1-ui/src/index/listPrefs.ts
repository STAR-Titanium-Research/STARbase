// How one list is shown, remembered per browser and per list (spec decisions 3-4): a table or a
// card grid, and three row densities. These are preferences of the person, not of the page, so
// they live in localStorage and stay out of the URL (which carries only what is being looked at).

export type ListView = 'table' | 'cards';
export type Density = 'compact' | 'normal' | 'roomy';
export interface ListPrefs {
	view: ListView;
	density: Density;
}

export const LIST_VIEWS: readonly ListView[] = ['table', 'cards'];
export const DENSITIES: readonly Density[] = ['compact', 'normal', 'roomy'];
export const DEFAULT_LIST_PREFS: Readonly<ListPrefs> = { view: 'table', density: 'normal' };

const KEY_PREFIX = 'd1.list.';
export const listPrefsKey = (slug: string): string => `${KEY_PREFIX}${slug}`;

function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null; // reading the property itself can throw when site data is blocked
	}
}

// The stored value is a JSON object; each half is checked on its own, so a good half survives a
// bad one. Nothing stored, a broken value or blocked storage gives the default.
export function readListPrefs(slug: string, storage: Storage | null = browserStorage()): ListPrefs {
	const prefs: ListPrefs = { ...DEFAULT_LIST_PREFS };
	try {
		const raw = storage?.getItem(listPrefsKey(slug));
		if (!raw) return prefs;
		const v: unknown = JSON.parse(raw);
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const { view, density } = v as Record<string, unknown>;
			if (LIST_VIEWS.includes(view as ListView)) prefs.view = view as ListView;
			if (DENSITIES.includes(density as Density)) prefs.density = density as Density;
		}
	} catch {
		// broken value or blocked storage: the default stands
	}
	return prefs;
}

export function writeListPrefs(slug: string, prefs: ListPrefs, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(listPrefsKey(slug), JSON.stringify({ view: prefs.view, density: prefs.density }));
	} catch {
		// private mode or blocked storage: the choice just is not remembered
	}
}

// Settings → Index pages → "Forget my list views": removes every list's saved view and density, and only
// those (the keys under this module's prefix), so the next visit to each list starts at the defaults.
export function forgetListPrefs(storage: Storage | null = browserStorage()): void {
	try {
		if (!storage) return;
		const keys: string[] = [];
		for (let i = 0; i < storage.length; i++) {
			const k = storage.key(i);
			if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
		}
		for (const k of keys) storage.removeItem(k);
	} catch {
		// blocked storage: nothing was remembered, so nothing is forgotten
	}
}

// Which radio gets focus (and is chosen) after `key` in a group of `count`, currently on `current`.
// Arrows wrap; Home and End jump to the ends; any other key is not ours (null).
export function nextRadioIndex(count: number, current: number, key: string): number | null {
	if (count <= 0) return null;
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
			return (current + 1) % count;
		case 'ArrowLeft':
		case 'ArrowUp':
			return (current - 1 + count) % count;
		case 'Home':
			return 0;
		case 'End':
			return count - 1;
		default:
			return null;
	}
}
