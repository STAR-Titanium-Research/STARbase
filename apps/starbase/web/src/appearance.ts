// The person's theme choice (Settings → Appearance, saved as the `theme` preference) as STARbase draws it:
// `data-theme="light|dark"` on <html> overrides the system scheme in theme.css; "system" removes it.
// The last choice is also kept in this browser, so a reload paints in it before the preference has loaded.
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES: ThemeChoice[] = ['system', 'light', 'dark'];
export const THEME_LABELS: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const CACHE_KEY = 'starbase.theme';

interface RootLike {
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
}

export function applyTheme(root: RootLike, theme: ThemeChoice): void {
	if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
	else root.removeAttribute('data-theme');
}

// Before anything is drawn: the last known choice (a "system" cache means no attribute).
export function restoreTheme(root: RootLike, storage?: Pick<Storage, 'getItem'> | null): void {
	applyTheme(root, storage === undefined ? cachedTheme() : cachedTheme(storage));
}

// Once the saved preferences have loaded, they decide and are remembered. Before that the default
// ("system") is not a choice: it must neither repaint nor overwrite the cache.
export function syncTheme(root: RootLike, loaded: boolean, theme: ThemeChoice, storage?: Pick<Storage, 'setItem' | 'removeItem'> | null): void {
	if (!loaded) return;
	applyTheme(root, theme);
	if (storage === undefined) cacheTheme(theme);
	else cacheTheme(theme, storage);
}

// The next choice when the toggle is pressed: System, Light, Dark, and round again.
export function nextTheme(theme: ThemeChoice): ThemeChoice {
	return THEME_CHOICES[(THEME_CHOICES.indexOf(theme) + 1) % THEME_CHOICES.length];
}

export function cachedTheme(storage: Pick<Storage, 'getItem'> | null = safeStorage()): ThemeChoice {
	try {
		const v = storage?.getItem(CACHE_KEY);
		return v === 'light' || v === 'dark' ? v : 'system';
	} catch {
		return 'system';
	}
}

export function cacheTheme(theme: ThemeChoice, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage()): void {
	try {
		if (theme === 'system') storage?.removeItem(CACHE_KEY);
		else storage?.setItem(CACHE_KEY, theme);
	} catch {
		// Private window or blocked storage: the preference alone decides.
	}
}

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}
