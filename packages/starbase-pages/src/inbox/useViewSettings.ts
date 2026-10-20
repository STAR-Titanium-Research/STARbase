import { reactive } from 'vue';
import { browserStorage } from '@d1/ui';
import { ZOOM_MODES, type ZoomMode } from './viewBoxModel';

// How the Inbox is shown, kept per person in this browser (spec 2026-10-20-inbox-file-viewer-design.md decision 7). These are preferences of the person, not of
// the page, so they live in localStorage under one key (in the d1.list. family, so Settings "Forget my list views" clears it too) and stay out of the URL.
// Every read and write is wrapped: with storage blocked or a broken value the page works on the defaults and the choice is simply not remembered.

/** What a click on a file opens: the sheet beside the list, or the full view box. */
export type PreviewMode = 'sheet' | 'box';

export interface InboxViewSettings {
	preview: PreviewMode;
	/** Whether the View rail is open (true) or folded to its tab (false). */
	railOpen: boolean;
	/** The view box's own right rail, open or folded: kept apart from the list's, so folding one does not fold the other. */
	boxRailOpen: boolean;
	/** The view box: the whole picture in the stage (fit) or one original pixel per screen pixel (actual, shown as 1:1). */
	zoom: ZoomMode;
	/** The view box: the scale bar over the picture (when the file says its scale). */
	scaleBar: boolean;
	/** The view box: contrast stretch, a display aid on the picture. */
	contrast: boolean;
}

export const VIEW_KEY = 'd1.list.inbox';
export const PREVIEW_MODES: readonly PreviewMode[] = ['sheet', 'box'];
export const DEFAULT_VIEW: Readonly<InboxViewSettings> = { preview: 'sheet', railOpen: true, boxRailOpen: true, zoom: 'fit', scaleBar: true, contrast: false };

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
			if (typeof r.railOpen === 'boolean') out.railOpen = r.railOpen;
			if (typeof r.boxRailOpen === 'boolean') out.boxRailOpen = r.boxRailOpen;
			if (ZOOM_MODES.includes(r.zoom as ZoomMode)) out.zoom = r.zoom as ZoomMode;
			if (typeof r.scaleBar === 'boolean') out.scaleBar = r.scaleBar;
			if (typeof r.contrast === 'boolean') out.contrast = r.contrast;
		}
	} catch {
		// broken value or blocked storage: the defaults stand
	}
	return out;
}

export function writeViewSettings(s: InboxViewSettings, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(VIEW_KEY, JSON.stringify({ preview: s.preview, railOpen: s.railOpen, boxRailOpen: s.boxRailOpen, zoom: s.zoom, scaleBar: s.scaleBar, contrast: s.contrast }));
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
