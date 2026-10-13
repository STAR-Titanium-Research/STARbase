// The sidebar's two layout preferences, kept in this browser too. The saved choice (Settings, per user)
// only arrives with GET /d1-usage/nav; until then the shell would draw the defaults (expanded) and jump to
// the rail when the answer came, shifting the page 164px on every load (and forget the choice for the
// session if the request failed). So the last known values draw the first paint, and the loaded
// preferences take over, rewriting this cache.
export interface LayoutPrefs {
	sidebarCollapsed: boolean;
	autoCollapse: boolean;
}

export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = { sidebarCollapsed: false, autoCollapse: true };
const KEY = 'starbase.sidebar';

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

export function cachedLayoutPrefs(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LayoutPrefs {
	try {
		const raw = storage?.getItem(KEY);
		const v = raw ? JSON.parse(raw) : null;
		return {
			sidebarCollapsed: typeof v?.sidebarCollapsed === 'boolean' ? v.sidebarCollapsed : DEFAULT_LAYOUT_PREFS.sidebarCollapsed,
			autoCollapse: typeof v?.autoCollapse === 'boolean' ? v.autoCollapse : DEFAULT_LAYOUT_PREFS.autoCollapse,
		};
	} catch {
		return { ...DEFAULT_LAYOUT_PREFS };
	}
}

export function cacheLayoutPrefs(prefs: LayoutPrefs, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
	try {
		storage?.setItem(KEY, JSON.stringify({ sidebarCollapsed: prefs.sidebarCollapsed, autoCollapse: prefs.autoCollapse }));
	} catch {
		// Private window or blocked storage: the saved preference alone decides.
	}
}

// What the layout reads: the cached values until the preferences have loaded, then the loaded ones.
export function pickLayoutPrefs(loaded: boolean, prefs: LayoutPrefs, cached: LayoutPrefs): LayoutPrefs {
	return loaded ? prefs : cached;
}
