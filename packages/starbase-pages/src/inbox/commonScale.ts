// "Common scale" for Compare, as plain functions: both pictures drawn at the same micrometres per screen pixel, so a feature is the same size in both panes.
// It needs both files to say their pixel size AND the original's width (the same two numbers Measure needs); otherwise it is off, with a reason.
import { measureScale } from './measure';

/** Why Common scale cannot work, or null when it can. */
export const COMMON_SCALE_REASON = 'needs the pixel size and width of both files';

/** A picture's full width in µm (pixel size x original width), or null when the file does not say both. */
export function fieldUm(extracted: Record<string, unknown> | null | undefined): number | null {
	const s = measureScale(extracted);
	return s ? (s.pixelSizeNm * s.originalWidthPx) / 1000 : null;
}

export const canCommonScale = (a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean => fieldUm(a) !== null && fieldUm(b) !== null;

export interface CommonWidths {
	/** The width each picture is drawn at, in screen pixels. */
	widthA: number;
	widthB: number;
	/** The shared scale: µm per screen pixel. */
	umPerPx: number;
}

/**
 * The widths that give both pictures one scale. Fit: the wider field (in µm) fills the pane and the other is drawn smaller in proportion. 1:1: the finer
 * pixel size is drawn one original pixel per screen pixel and the other in proportion. Null when either file lacks its scale, or (Fit) the pane has no width yet.
 */
export function commonScaleWidths(
	a: Record<string, unknown> | null | undefined,
	b: Record<string, unknown> | null | undefined,
	zoom: 'fit' | 'actual',
	paneWidthPx: number,
): CommonWidths | null {
	const sa = measureScale(a);
	const sb = measureScale(b);
	if (!sa || !sb) return null;
	const fa = (sa.pixelSizeNm * sa.originalWidthPx) / 1000;
	const fb = (sb.pixelSizeNm * sb.originalWidthPx) / 1000;
	let umPerPx: number;
	if (zoom === 'actual') umPerPx = Math.min(sa.pixelSizeNm, sb.pixelSizeNm) / 1000;
	else {
		if (!Number.isFinite(paneWidthPx) || paneWidthPx <= 0) return null;
		umPerPx = Math.max(fa, fb) / paneWidthPx;
	}
	return { widthA: fa / umPerPx, widthB: fb / umPerPx, umPerPx };
}
