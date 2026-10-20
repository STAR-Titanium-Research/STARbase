import { reactive } from 'vue';

// How the Inbox is shown, kept per person in this browser (spec 2026-10-20-inbox-file-viewer-design.md decision 7). These are preferences of the person, not of
// the page, so they live in localStorage under one key and stay out of the URL. Every read and write is wrapped: with storage blocked or a broken value the
// page works on the defaults and the choice is simply not remembered.

/** What a click on a file opens: the sheet beside the list, or the full view box. */
export type PreviewMode = 'sheet' | 'box';
export type LayoutMode = 'cards' | 'table';
export type DensityMode = 'compact' | 'normal' | 'roomy';

export interface InboxViewSettings {
	preview: PreviewMode;
	/** Stored for the table layout that comes later; the list is drawn as cards whatever it says. */
	layout: LayoutMode;
	/** Stored for the same reason as `layout`. */
	density: DensityMode;
	/** Whether the View rail is open (true) or folded to its tab (false). */
	railOpen: boolean;
}

export const VIEW_KEY = 'starbase.inbox.view';
export const PREVIEW_MODES: readonly PreviewMode[] = ['sheet', 'box'];
export const LAYOUT_MODES: readonly LayoutMode[] = ['cards', 'table'];
export const DENSITY_MODES: readonly DensityMode[] = ['compact', 'normal', 'roomy'];
export const DEFAULT_VIEW: Readonly<InboxViewSettings> = { preview: 'sheet', layout: 'cards', density: 'normal', railOpen: true };

function browserStorage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null; // reading the property itself throws when site data is blocked
	}
}

/** The stored settings. Each field is checked on its own, so a good one survives a bad one; nothing stored, a broken value or blocked storage gives the default. */
export function readViewSettings(storage: Storage | null = browserStorage()): InboxViewSettings {
	const out: InboxViewSettings = { ...DEFAULT_VIEW };
	try {
		const raw = storage?.getItem(VIEW_KEY);
		if (!raw) return out;
		const v: unknown = JSON.parse(raw);
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const r = v as Record<string, unknown>;
			if (PREVIEW_MODES.includes(r.preview as PreviewMode)) out.preview = r.preview as PreviewMode;
			if (LAYOUT_MODES.includes(r.layout as LayoutMode)) out.layout = r.layout as LayoutMode;
			if (DENSITY_MODES.includes(r.density as DensityMode)) out.density = r.density as DensityMode;
			if (typeof r.railOpen === 'boolean') out.railOpen = r.railOpen;
		}
	} catch {
		// broken value or blocked storage: the defaults stand
	}
	return out;
}

export function writeViewSettings(s: InboxViewSettings, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(VIEW_KEY, JSON.stringify({ preview: s.preview, layout: s.layout, density: s.density, railOpen: s.railOpen }));
	} catch {
		// private mode, a full disk or blocked storage: the choice just is not remembered
	}
}

/** The live settings for a page: read once when called, written whenever `set` changes one. */
export function useViewSettings(storage: Storage | null = browserStorage()) {
	const settings = reactive<InboxViewSettings>(readViewSettings(storage));
	function set(patch: Partial<InboxViewSettings>): void {
		Object.assign(settings, patch);
		writeViewSettings(settings, storage);
	}
	return { settings, set };
}
