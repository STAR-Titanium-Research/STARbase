import { reactive } from 'vue';
import { browserStorage } from '@d1/ui';
import { MEASURE_TOOLS, type MeasureTool } from './measure';
import { ZOOM_MODES, type ZoomMode } from './viewBoxModel';

// How the Inbox is shown, kept per person in this browser (spec 2026-10-20-inbox-file-viewer-design.md decision 7). These are preferences of the person, not of
// the page, so they live in localStorage under one key (in the d1.list. family, so Settings "Forget my list views" clears it too) and stay out of the URL.
// Every read and write is wrapped: with storage blocked or a broken value the page works on the defaults and the choice is simply not remembered.

/** What a click on a file opens: the sheet beside the list, or the full view box. */
export type PreviewMode = 'sheet' | 'box';
/** The view box's Compare setting. */
export type CompareMode = 'off' | 'side';

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
	/** The list: rows can be ticked to compare two files ("Compare two files" in the Inbox View rail). */
	compareList: boolean;
	/** The view box: one file (off) or two side by side. */
	compare: CompareMode;
	/** Compare: zoom (Fit / 1:1) and pan move together in both panes. */
	linkZoom: boolean;
	/** Compare: both pictures at the same micrometres per screen pixel (when both files say their scale). */
	commonScale: boolean;
	/** The view box: what Measure draws, a line, a circle or a polygon (keys 1, 2, 3). */
	measureTool: MeasureTool;
}

export const VIEW_KEY = 'd1.list.inbox';
export const PREVIEW_MODES: readonly PreviewMode[] = ['sheet', 'box'];
export const COMPARE_MODES: readonly CompareMode[] = ['off', 'side'];
export const DEFAULT_VIEW: Readonly<InboxViewSettings> = {
	preview: 'sheet', railOpen: true, boxRailOpen: true, zoom: 'fit', scaleBar: true, contrast: false, compareList: false, compare: 'off', linkZoom: true, commonScale: true, measureTool: 'line',
};

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
			if (typeof r.compareList === 'boolean') out.compareList = r.compareList;
			if (COMPARE_MODES.includes(r.compare as CompareMode)) out.compare = r.compare as CompareMode;
			if (typeof r.linkZoom === 'boolean') out.linkZoom = r.linkZoom;
			if (typeof r.commonScale === 'boolean') out.commonScale = r.commonScale;
			if (MEASURE_TOOLS.includes(r.measureTool as MeasureTool)) out.measureTool = r.measureTool as MeasureTool;
		}
	} catch {
		// broken value or blocked storage: the defaults stand
	}
	return out;
}

export function writeViewSettings(s: InboxViewSettings, storage: Storage | null = browserStorage()): void {
	try {
		storage?.setItem(
			VIEW_KEY,
			JSON.stringify({
				preview: s.preview, railOpen: s.railOpen, boxRailOpen: s.boxRailOpen, zoom: s.zoom, scaleBar: s.scaleBar, contrast: s.contrast,
				compareList: s.compareList, compare: s.compare, linkZoom: s.linkZoom, commonScale: s.commonScale, measureTool: s.measureTool,
			}),
		);
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
