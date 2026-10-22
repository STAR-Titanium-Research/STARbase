// The Measurements list of the view box, as plain functions (no Vue, no DOM): saved shapes (kept by the server in pixels of the ORIGINAL image, see
// inboxApiTypes.ts SavedMeasurement) turned into list rows ("1 Line 212 µm"), CSV, and back and forth between the fractions of the preview that the drawing
// layer works in (measure.ts MeasureShape) and the original's pixels that are stored. Unit-free on the server: micrometres are worked out here, from the file's scale.
//
// One ratio does both axes: original pixels per preview pixel = the original's width / the preview's width (measure.ts previewRatio), so a corner at fraction
// (fx, fy) of a preview of W x H pixels is at (fx * W * ratio, fy * H * ratio) = (fx * originalWidth, fy * H/W * originalWidth) original pixels, and the
// original's height is never needed (the preview is a reduced copy of the same picture).
import type { MeasurementKind, NewMeasurement, OriginalPoint, SavedMeasurement } from './inboxApiTypes';
import { finitePositive, formatArea, formatLength, polygonArea, polygonPerimeter, pixelDistance, selfIntersects, type MeasureScale, type MeasureShape, type Pt, type ShapeMeasure } from './measure';

/** The preview's natural size (the fractions of a drawn shape are of it). */
export interface PreviewSize {
	width: number;
	height: number;
}

const sizeOk = (p: PreviewSize | null | undefined): p is PreviewSize => !!p && finitePositive(p.width) && finitePositive(p.height);

/** A drawn shape (fractions of the preview) as what the server keeps: corners in original pixels. Null for a polygon that is not finished or has fewer than 3 corners, and when the scale or the size is unknown. */
export function shapeToNew(shape: MeasureShape, preview: PreviewSize | null | undefined, scale: MeasureScale | null): NewMeasurement | null {
	if (!scale || !sizeOk(preview) || !finitePositive(scale.originalWidthPx)) return null;
	const k = scale.originalWidthPx; // original pixels across the whole width
	const aspect = preview.height / preview.width;
	const px = (p: Pt): OriginalPoint => ({ x: p.x * k, y: p.y * k * aspect });
	if (shape.kind === 'line') return { kind: 'line', points: [px(shape.a), px(shape.b)] };
	if (shape.kind === 'circle') return { kind: 'circle', points: [px(shape.c), px(shape.r)] };
	if (!shape.closed || shape.pts.length < 3) return null;
	return { kind: 'polygon', points: shape.pts.map(px) };
}

/** A saved shape as fractions of the preview again, ready to draw. Null when the scale or the size is unknown, or the corners do not fit the kind. */
export function savedToShape(m: Pick<SavedMeasurement, 'kind' | 'points'>, preview: PreviewSize | null | undefined, scale: MeasureScale | null): MeasureShape | null {
	if (!scale || !sizeOk(preview) || !finitePositive(scale.originalWidthPx)) return null;
	const k = scale.originalWidthPx;
	const aspect = preview.height / preview.width;
	const at = (p: OriginalPoint): Pt => ({ x: p.x / k, y: p.y / (k * aspect) });
	if (m.kind === 'line') return m.points.length === 2 ? { kind: 'line', a: at(m.points[0]), b: at(m.points[1]) } : null;
	if (m.kind === 'circle') return m.points.length === 2 ? { kind: 'circle', c: at(m.points[0]), r: at(m.points[1]) } : null;
	return m.points.length >= 3 ? { kind: 'polygon', pts: m.points.map(at), closed: true } : null;
}

/** What a saved shape measures, in µm and µm², straight from its original pixels (so it needs no preview): length x pixel size, area x pixel size squared. Null without a scale. */
export function savedMeasure(m: Pick<SavedMeasurement, 'kind' | 'points'>, scale: MeasureScale | null): ShapeMeasure | null {
	if (!scale || !finitePositive(scale.pixelSizeNm)) return null;
	const um = scale.pixelSizeNm / 1000; // µm per original pixel
	if (m.kind === 'line') return m.points.length === 2 ? { kind: 'line', length: pixelDistance(m.points[0], m.points[1]) * um } : null;
	if (m.kind === 'circle') {
		if (m.points.length !== 2) return null;
		const r = pixelDistance(m.points[0], m.points[1]) * um;
		return { kind: 'circle', diameter: 2 * r, radius: r, circumference: 2 * Math.PI * r, area: Math.PI * r * r };
	}
	if (m.points.length < 3) return null;
	return { kind: 'polygon', area: polygonArea(m.points) * um * um, perimeter: polygonPerimeter(m.points) * um, selfIntersects: selfIntersects(m.points) };
}

export const KIND_WORD: Record<MeasurementKind, string> = { line: 'Line', circle: 'Circle', polygon: 'Polygon' };

/** What a row says its shape measures: "212 µm", "Ø 88 µm", "12,400 µm²" (empty when it cannot be worked out). */
export function valueText(m: ShapeMeasure | null): string {
	if (!m) return '';
	if (m.kind === 'line') return formatLength(m.length);
	if (m.kind === 'circle') return `Ø ${formatLength(m.diameter)}`;
	return formatArea(m.area);
}

/** Oldest first, ties by id: the order the list numbers them in (the server sends it so; a shape saved here is put in its place the same way). */
export function orderMeasurements<T extends Pick<SavedMeasurement, 'created_at' | 'measurement_id'>>(list: readonly T[]): T[] {
	return [...list].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.measurement_id.localeCompare(b.measurement_id));
}

/** One line of the Measurements list. */
export interface MeasurementRow {
	id: string;
	/** 1, 2, 3 ... in saving order. */
	n: number;
	kind: MeasurementKind;
	/** The person's name for it ("" for none). */
	label: string;
	/** The label, else "Line", "Circle" or "Polygon". */
	name: string;
	/** "212 µm", "Ø 88 µm", "12,400 µm²". */
	value: string;
	measure: ShapeMeasure | null;
	/** Who saved it, for the tooltip (null once their login is gone). */
	author: string | null;
	canEdit: boolean;
}

/** The rows of the list: numbered in saving order, each with its name and value. */
export function measurementRows(list: readonly SavedMeasurement[], scale: MeasureScale | null): MeasurementRow[] {
	return orderMeasurements(list).map((m, i) => {
		const measure = savedMeasure(m, scale);
		return { id: m.measurement_id, n: i + 1, kind: m.kind, label: m.label, name: m.label || KIND_WORD[m.kind], value: valueText(measure), measure, author: m.author_name, canEdit: m.can_edit };
	});
}

/** "1 Line 212 µm": the row as one line of text (the button's name for a screen reader, and what a test reads). */
export const rowText = (r: MeasurementRow): string => [r.n, r.name, r.value].filter((p) => p !== '').join(' ');

// ---- CSV: one header, one row per shape; plain decimals (no thousands separator, no unit text) so a spreadsheet reads each cell as a number ----

export const CSV_HEADER = ['n', 'label', 'kind', 'length_um', 'diameter_um', 'perimeter_um', 'area_um2'] as const;

/** A number as a plain decimal with 6 significant digits ("212.35", "0.0085", "12400"): no thousands separator, and no exponent form for any size a picture can hold. */
export function plain(x: number): string {
	if (!Number.isFinite(x)) return '';
	const r = Number(x.toPrecision(6));
	const s = String(r);
	return /e/i.test(s) ? r.toFixed(12).replace(/\.?0+$/, '') : s;
}

/** A text cell: quoted when it holds a comma, a quote or a line break; a leading = + - @ (or a tab) is made harmless, so a spreadsheet does not run a label as a formula. */
export function csvText(s: string): string {
	const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
	return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows as CSV for pasting into a spreadsheet: the header, then n, label, kind and the sizes that apply to the kind (length for a line; diameter, circumference as perimeter and area for a circle; perimeter and area for a polygon), the rest empty. */
export function measurementsToCsv(rows: readonly MeasurementRow[]): string {
	const lines = rows.map((r) => {
		const m = r.measure;
		const cells = [
			String(r.n), csvText(r.label), r.kind,
			m?.kind === 'line' ? plain(m.length) : '',
			m?.kind === 'circle' ? plain(m.diameter) : '',
			m?.kind === 'circle' ? plain(m.circumference) : m?.kind === 'polygon' ? plain(m.perimeter) : '',
			m?.kind === 'circle' || m?.kind === 'polygon' ? plain(m.area) : '',
		];
		return cells.join(',');
	});
	return [CSV_HEADER.join(','), ...lines].join('\n') + '\n';
}
