// The view box page's rules as plain functions (no Vue, no network): where its addresses lead, which file comes before and after the open one in the list the
// person came from, the "n of m" text, how big the picture is drawn for Fit and 1:1, and the scale bar at either size.
// Spec: docs/superpowers/specs/2026-10-20-inbox-file-viewer-design.md decisions 4, 8 and 9.
import { filtersToQuery, type InboxFilters } from './inboxModel';
import { finitePositive, measureScale } from './measure';
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
export function viewBoxPath(candidateId: string, f: InboxFilters, partnerId?: string | null): string {
	const q = new URLSearchParams(filtersToQuery(f));
	if (partnerId && partnerId !== candidateId) q.set('with', partnerId);
	const text = q.toString();
	return `/inbox/file/${encodeURIComponent(candidateId)}${text ? `?${text}` : ''}`;
}

/** The compare partner a page address names (`?with=<candidateId>`): the first value, or '' when there is none or it is the open file itself. */
export function partnerOf(query: Record<string, unknown>, openId: string): string {
	const v = Array.isArray(query.with) ? query.with[0] : query.with;
	return typeof v === 'string' && v && v !== openId ? v : '';
}

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

/**
 * The width, in screen pixels, the picture is drawn at for 1:1: the original's width as the one scale rule reads it (measureScale: the stored width, or the field
 * width over the pixel size when none was stored, so 1:1 and Common scale agree), else a stored width alone, else the preview's own width. Null when none is known yet.
 */
export function actualWidthPx(extracted: Record<string, unknown>, previewWidthPx: number | null): number | null {
	const original = measureScale(extracted)?.originalWidthPx;
	if (original !== undefined) return original;
	if (finitePositive(extracted.image_width_px)) return extracted.image_width_px;
	return finitePositive(previewWidthPx) ? previewWidthPx : null;
}

/** The scale bar for the picture at this zoom, or null when the file does not say its scale. At 1:1 the bar is held to about 150 screen pixels, so it never runs across a wide picture. */
export function boxScaleBar(extracted: Record<string, unknown>, zoom: ZoomMode, drawnWidthPx: number | null): SheetBar | null {
	const share = zoom === 'actual' && finitePositive(drawnWidthPx) ? Math.min(0.22, 150 / drawnWidthPx) : 0.22;
	return sheetScaleBar(extracted, share);
}

/** Fields that take typed text: the letter and number keys (F, M, C, 1 2 3, Enter, Backspace) stay out of them, but not out of a checkbox or a radio, so they work right after a click on one. */
export const TEXT_ENTRY = 'input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable=""], [contenteditable="true"]';
