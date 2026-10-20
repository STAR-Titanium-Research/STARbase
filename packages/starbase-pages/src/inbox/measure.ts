// Measuring on the picture, as plain functions (no Vue, no DOM). The picture on the screen is the stored PREVIEW (about 1600 px wide), a reduced copy of an
// original whose pixel size the file says (`pixel_size_nm`, nanometres per ORIGINAL pixel) and whose width it also says (`image_width_px`). So a distance
// of P preview pixels is P x (original width / preview width) original pixels, and that times the pixel size is the length on the sample.
// A line is kept as fractions (0 to 1) of the picture's width and height, so it survives Fit / 1:1 and a resize; its length in preview pixels is then the
// fraction times the preview's own (natural) size, never the size it happens to be drawn at.
// Spec: docs/superpowers/specs/2026-10-20-inbox-file-viewer-design.md decisions 1 and 6.

export interface Pt {
	x: number;
	y: number;
}

/** A line drawn on a picture: its ends as fractions (0 to 1) of the picture's width and height (they hold at any size it is drawn at) and its length in µm, worked out when it was drawn. */
export interface MeasureLine {
	a: Pt;
	b: Pt;
	um: number;
}

export interface MeasureScale {
	/** Nanometres per pixel of the ORIGINAL image. */
	pixelSizeNm: number;
	/** The original's width in pixels. */
	originalWidthPx: number;
}

/** What Measure says when it cannot work (also the tooltip of its disabled switch). */
export const NO_SCALE_REASON = 'no scale known for this image';

export const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Measure needs BOTH the pixel size and the original's width (no fallback to the field width or to the preview's width): else null. */
export function measureScale(extracted: Record<string, unknown> | null | undefined): MeasureScale | null {
	const px = extracted?.pixel_size_nm;
	if (!finitePositive(px)) return null;
	const w = extracted?.image_width_px;
	if (finitePositive(w)) return { pixelSizeNm: px, originalWidthPx: w };
	// A file whose metadata gave the field width and the pixel size (a FEI TIFF read before the width was stored) has its width in them:
	// field width / pixel size (198.933 µm / 194.271 nm = 1024 px). Both must come from the file; nothing is taken from the preview.
	const hfw = extracted?.hfw_um;
	return finitePositive(hfw) ? { pixelSizeNm: px, originalWidthPx: (hfw * 1000) / px } : null;
}

/** The picture's full width in µm (pixel size x original width): the one rule the scale bar, Measure and Common scale all share. */
export const scaleFieldUm = (s: MeasureScale): number => (s.pixelSizeNm * s.originalWidthPx) / 1000;

/** Original pixels per preview pixel (original width / preview width); null when either is unknown. */
export function previewRatio(originalWidthPx: number, previewWidthPx: number): number | null {
	return finitePositive(originalWidthPx) && finitePositive(previewWidthPx) ? originalWidthPx / previewWidthPx : null;
}

/** The straight distance between two points, in whatever unit they are in. */
export const pixelDistance = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

/** A distance in preview pixels as micrometres: pixels x ratio x nm per pixel / 1000. Null when the pixel size or the ratio is unknown. */
export function distanceUm(previewPx: number, pixelSizeNm: number | null | undefined, ratio: number | null | undefined): number | null {
	if (!finitePositive(pixelSizeNm) || !finitePositive(ratio) || !Number.isFinite(previewPx) || previewPx < 0) return null;
	return (previewPx * ratio * pixelSizeNm) / 1000;
}

/** The length in µm of a line given as fractions of the picture, on a preview of this natural size; null when the scale or the size is unknown. */
export function lineUm(a: Pt, b: Pt, previewSize: { width: number; height: number }, scale: MeasureScale | null): number | null {
	if (!scale || !finitePositive(previewSize.width) || !finitePositive(previewSize.height)) return null;
	const px = pixelDistance({ x: a.x * previewSize.width, y: a.y * previewSize.height }, { x: b.x * previewSize.width, y: b.y * previewSize.height });
	return distanceUm(px, scale.pixelSizeNm, previewRatio(scale.originalWidthPx, previewSize.width));
}

const GB = 'en-GB';
const fixed = (n: number, digits: number): string => n.toLocaleString(GB, { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** "194.27 µm"; under 1 µm in nanometres ("430 nm", "8.5 nm"). Always a sensible number of decimals: 2 for µm, none from 10 nm up. */
export function formatLength(um: number): string {
	if (!Number.isFinite(um) || um < 0) return '';
	if (um < 1) {
		const nm = um * 1000;
		return `${fixed(nm, nm < 10 ? 1 : 0)} nm`;
	}
	return `${fixed(um, 2)} µm`;
}
