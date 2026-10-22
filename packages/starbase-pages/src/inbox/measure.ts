// Measuring on the picture, as plain functions (no Vue, no DOM). The picture on the screen is the stored PREVIEW (about 1600 px wide), a reduced copy of an
// original whose pixel size the file says (`pixel_size_nm`, nanometres per ORIGINAL pixel) and whose width it also says (`image_width_px`). So a distance
// of P preview pixels is P x (original width / preview width) original pixels, and that times the pixel size is the length on the sample.
// A shape (line, circle, polygon) is kept as fractions (0 to 1) of the picture's width and height, so it survives Fit / 1:1 and a resize; its size in preview
// pixels is then the fraction times the preview's own (natural) size, never the size it happens to be drawn at.
// Spec: docs/superpowers/specs/2026-10-20-inbox-file-viewer-design.md decisions 1 and 6.

export interface Pt {
	x: number;
	y: number;
}

/**
 * A shape drawn on a picture, kept as fractions (0 to 1) of the picture's width and height so it holds at any size it is drawn at (Fit, 1:1, a resize):
 * a line (its two ends), a circle (its centre and one point on its rim) or a polygon (its corners in the order they were clicked; `closed` once it is finished).
 * What it measures is worked out from it (shapeUm), never stored in it.
 */
export type MeasureShape =
	| { kind: 'line'; a: Pt; b: Pt }
	| { kind: 'circle'; c: Pt; r: Pt }
	| { kind: 'polygon'; pts: Pt[]; closed: boolean };

export type MeasureTool = MeasureShape['kind'];
export const MEASURE_TOOLS: readonly MeasureTool[] = ['line', 'circle', 'polygon'];

export interface MeasureScale {
	/** Nanometres per pixel of the ORIGINAL image. */
	pixelSizeNm: number;
	/** The original's width in pixels. */
	originalWidthPx: number;
}

/** What Measure says when it cannot work (also the tooltip of its disabled switch). */
export const NO_SCALE_REASON = 'no scale known for this image';

export const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Measure needs the pixel size and the original's width: the stored width, or the one worked out from the field width and the pixel size (never the preview's width); else null. */
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

const GB = 'en-GB';
const fixed = (n: number, digits: number): string => n.toLocaleString(GB, { minimumFractionDigits: 0, maximumFractionDigits: digits });

/** "194.27 µm"; under 1 µm in nanometres ("430 nm", "8.5 nm"). Always a sensible number of decimals: 2 for µm, none from 10 nm up. */
export function formatLength(um: number): string {
	if (!Number.isFinite(um) || um < 0) return '';
	if (um < 0.9995) { // 0.9995 µm and up would round to "1,000 nm": it is "1 µm"
		const nm = um * 1000;
		return `${fixed(nm, nm < 10 ? 1 : 0)} nm`;
	}
	return `${fixed(um, 2)} µm`;
}

/** Square micrometres as text: "35,299 µm²" (2 decimals under 10, 1 under 100, none above); from 1 mm² up in mm² ("1.25 mm²"). Never nm². */
export function formatArea(um2: number): string {
	if (!Number.isFinite(um2) || um2 < 0) return '';
	if (um2 >= 1e6) return `${fixed(um2 / 1e6, 2)} mm²`;
	return `${fixed(um2, um2 < 10 ? 2 : um2 < 100 ? 1 : 0)} µm²`;
}

/** What a shape measures, in µm and µm². */
export type ShapeMeasure =
	| { kind: 'line'; length: number }
	| { kind: 'circle'; diameter: number; radius: number; circumference: number; area: number }
	| { kind: 'polygon'; area: number; perimeter: number; selfIntersects: boolean };

/** The area of a polygon by the shoelace formula, always positive (the same whichever way round the corners were clicked). */
export function polygonArea(pts: readonly Pt[]): number {
	let sum = 0;
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i];
		const q = pts[(i + 1) % pts.length];
		sum += p.x * q.y - q.x * p.y;
	}
	return Math.abs(sum) / 2;
}

/** The length round a closed polygon (the closing side included). */
export function polygonPerimeter(pts: readonly Pt[]): number {
	let sum = 0;
	for (let i = 0; i < pts.length; i++) sum += pixelDistance(pts[i], pts[(i + 1) % pts.length]);
	return sum;
}

const turn = (o: Pt, a: Pt, b: Pt): number => Math.sign((a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x));

/** Whether two sides that are not neighbours cross each other (a "bow tie"), when the shoelace area is not the area the person meant. Touching and overlapping are not counted. */
export function selfIntersects(pts: readonly Pt[]): boolean {
	const n = pts.length;
	if (n < 4) return false;
	for (let i = 0; i < n; i++) {
		const a = pts[i];
		const b = pts[(i + 1) % n];
		for (let j = i + 1; j < n; j++) {
			if (j === i + 1 || (i === 0 && j === n - 1)) continue; // neighbours share a corner
			const c = pts[j];
			const d = pts[(j + 1) % n];
			if (turn(a, b, c) * turn(a, b, d) < 0 && turn(c, d, a) * turn(c, d, b) < 0) return true;
		}
	}
	return false;
}

/**
 * What a shape measures, given the preview's natural size (the fractions are of it) and the scale; null when the scale or the size is unknown, or a polygon has
 * fewer than 3 corners. Lengths in µm and areas in µm²: preview pixels x ratio x nm per pixel / 1000, so an area goes with the square of the ratio.
 */
export function shapeUm(shape: MeasureShape, previewSize: { width: number; height: number }, scale: MeasureScale | null): ShapeMeasure | null {
	if (!scale || !finitePositive(previewSize.width) || !finitePositive(previewSize.height)) return null;
	const um = distanceUm(1, scale.pixelSizeNm, previewRatio(scale.originalWidthPx, previewSize.width)); // µm per preview pixel
	if (um === null) return null;
	const px = (p: Pt): Pt => ({ x: p.x * previewSize.width, y: p.y * previewSize.height });
	if (shape.kind === 'line') return { kind: 'line', length: pixelDistance(px(shape.a), px(shape.b)) * um };
	if (shape.kind === 'circle') {
		const r = pixelDistance(px(shape.c), px(shape.r)) * um;
		return { kind: 'circle', diameter: 2 * r, radius: r, circumference: 2 * Math.PI * r, area: Math.PI * r * r };
	}
	if (shape.pts.length < 3) return null;
	const pts = shape.pts.map(px);
	return { kind: 'polygon', area: polygonArea(pts) * um * um, perimeter: polygonPerimeter(pts) * um, selfIntersects: selfIntersects(pts) };
}

/** The words in the pill on the picture: "212 µm", "Ø 212 µm · area 35,299 µm²", "area 12,400 µm² · perimeter 460 µm" (also "area 0 µm²" for corners on one straight line; plus "check the outline" when sides cross). Empty when there is nothing to say yet. */
export function measureText(m: ShapeMeasure | null): string {
	if (!m) return '';
	if (m.kind === 'line') return m.length > 0 ? formatLength(m.length) : '';
	if (m.kind === 'circle') return m.radius > 0 ? `Ø ${formatLength(m.diameter)} · area ${formatArea(m.area)}` : '';
	if (!(m.perimeter > 0)) return ''; // all corners on one spot; corners on one straight line (area 0) still have a perimeter, so they say "area 0 µm²" and it
	return `area ${formatArea(m.area)} · perimeter ${formatLength(m.perimeter)}${m.selfIntersects ? ' · check the outline' : ''}`;
}
