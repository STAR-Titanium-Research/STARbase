// The logic of the View rail (ViewRail.vue): whether it is open, remembered per page kind in
// localStorage, the key that toggles it, and where it turns into a popover. Pure, so the component
// stays thin and the rules are tested without a DOM.

/** Content width (px) below which the rail is a "View" button with a popover. */
export const POPOVER_BELOW = 1100;

function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null; // reading the property itself can throw when site data is blocked
	}
}

/** Open or closed as last left on this device; `fallback` when nothing (or nothing readable) is stored. */
export function readRailOpen(key: string, fallback: boolean, storage: Storage | null = browserStorage()): boolean {
	try {
		const raw = storage?.getItem(key);
		return raw === '1' ? true : raw === '0' ? false : fallback;
	} catch {
		return fallback;
	}
}

export function writeRailOpen(key: string, open: boolean, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(key, open ? '1' : '0');
	} catch {
		// private mode or blocked storage: the choice just is not remembered
	}
}

// The part of a keyboard event the toggle looks at, so tests need no DOM.
export interface RailKeyEvent {
	key: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	defaultPrevented?: boolean;
	target?: object | null;
	getModifierState?: (key: string) => boolean;
}

/**
 * `\` toggles the rail, but never while a field has the keyboard (it is a character there) or with a modifier
 * held. AltGr is not a modifier here: on German, French or Italian keyboards it is how `\` is typed (Windows
 * reports it as Ctrl+Alt).
 */
export function isRailToggleKey(e: RailKeyEvent): boolean {
	const altGr = !!e.getModifierState?.('AltGraph');
	if (e.key !== '\\' || e.metaKey || e.defaultPrevented || (!altGr && (e.ctrlKey || e.altKey))) return false;
	const t = e.target as { tagName?: string; isContentEditable?: boolean } | null | undefined;
	if (t?.isContentEditable) return false;
	return !['INPUT', 'TEXTAREA', 'SELECT'].includes((t?.tagName ?? '').toUpperCase());
}

/** The width the rail is judged by: the nearest ancestor that is an inline-size container (the page's content), else the window. */
export function contentWidth(el: Element): number {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const type = getComputedStyle(p).containerType;
		if (type === 'inline-size' || type === 'size') return p.clientWidth;
	}
	return window.innerWidth;
}
