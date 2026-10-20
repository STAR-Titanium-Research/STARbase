// The view box page's rules as plain functions (no Vue, no network): where its addresses lead, which file comes before and after the open one in the list the
// person came from, the "n of m" text, how big the picture is drawn for Fit and 1:1, and the scale bar at either size.
// Spec: docs/superpowers/specs/2026-10-20-inbox-file-viewer-design.md decisions 4, 8 and 9.
import { filtersToQuery, type InboxFilters } from './inboxModel';
import { sheetScaleBar, type SheetBar } from './sheetScale';

/** Fit draws the whole picture in the stage; 1:1 draws one picture pixel of the ORIGINAL per screen pixel (the preview is a reduced copy, so it is scaled up). */
export type ZoomMode = 'fit' | 'actual';
export const ZOOM_MODES: readonly ZoomMode[] = ['fit', 'actual'];

/** Contrast stretch is a display aid only: a CSS filter on the picture; nothing about the file changes. */
export const CONTRAST_FILTER = 'contrast(1.6) brightness(1.05)';

const queryText = (f: InboxFilters): string => {
	const q = new URLSearchParams(filtersToQuery(f)).toString();
	return q ? `?${q}` : '';
};

/** The Inbox list with these filters, as a link path ("/inbox?kind=sem_image"). */
export const listPath = (f: InboxFilters): string => `/inbox${queryText(f)}`;

/** The view box page of one found file, carrying the list's filters so prev/next and Close stay in the same list. */
export const viewBoxPath = (candidateId: string, f: InboxFilters): string => `/inbox/file/${encodeURIComponent(candidateId)}${queryText(f)}`;

/** The route path of the view box page with its file swapped (prev/next): "/inbox/file/a" -> "/inbox/file/b"; any prefix the host mounts the pages under stays. */
export const swapCandidate = (path: string, candidateId: string): string => path.replace(/\/file\/[^/]*\/?$/, `/file/${encodeURIComponent(candidateId)}`);

/** The route path of the list the view box page belongs to: "/inbox/file/a" -> "/inbox". */
export const listBase = (path: string): string => path.replace(/\/file\/[^/]*\/?$/, '') || '/inbox';

export interface Neighbours {
	/** Position of the file in the list, from 0. */
	index: number;
	prev: string | null;
	next: string | null;
}

/** Where `id` sits in `ids` and which files are around it; null when it is not in the list (the page then shows no prev/next and no "n of m": it never guesses). */
export function neighbours(ids: readonly string[], id: string): Neighbours | null {
	const index = ids.indexOf(id);
	if (index < 0) return null;
	return { index, prev: index > 0 ? ids[index - 1] : null, next: index < ids.length - 1 ? ids[index + 1] : null };
}

/** "3 of 120"; `total` is the list's full size (the server's), which can be more than the files fetched. */
export const positionText = (index: number, total: number): string => `${index + 1} of ${Math.max(total, index + 1)}`;

const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * The width, in screen pixels, the picture is drawn at for 1:1: the original's width (from the file: extracted.image_width_px), or the preview's own
 * width when the file does not say. Null when neither is known yet.
 */
export function actualWidthPx(extracted: Record<string, unknown>, previewWidthPx: number | null): number | null {
	if (finitePositive(extracted.image_width_px)) return extracted.image_width_px;
	return finitePositive(previewWidthPx) ? previewWidthPx : null;
}

/** The scale bar for the picture at this zoom, or null when the file does not say its scale. At 1:1 the bar is held to about 150 screen pixels, so it never runs across a wide picture. */
export function boxScaleBar(extracted: Record<string, unknown>, zoom: ZoomMode, drawnWidthPx: number | null): SheetBar | null {
	const share = zoom === 'actual' && finitePositive(drawnWidthPx) ? Math.min(0.22, 150 / drawnWidthPx) : 0.22;
	return sheetScaleBar(extracted, share);
}
