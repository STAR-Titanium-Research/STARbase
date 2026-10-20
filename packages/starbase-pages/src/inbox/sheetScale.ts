import { scaleBarText } from './semSettings';

// The scale bar drawn over the picture in the sheet. The preview is a reduced copy, so the bar is sized as a share of the picture's width (which holds at
// any size) rather than in screen pixels: the picture's width in µm is pixel size x original width, or the recorded field width when the original's width is not known.

export interface SheetBar {
	/** The bar's length as a share of the picture's width, 0 to 1. */
	fraction: number;
	/** "10 µm", "500 nm". */
	label: string;
}

const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** The picture's full width in µm, or null when the file does not say enough. */
export function widthUm(extracted: Record<string, unknown>): number | null {
	const px = extracted.pixel_size_nm;
	if (!finitePositive(px)) return null;
	const w = extracted.image_width_px;
	if (finitePositive(w)) return (px * w) / 1000;
	return finitePositive(extracted.hfw_um) ? extracted.hfw_um : null;
}

/** A round length (1, 2 or 5 x 10^n µm) that fills about `target` of the width, never more than `max` of it. */
export function sheetScaleBar(extracted: Record<string, unknown>, target = 0.22, max = 0.4): SheetBar | null {
	const total = widthUm(extracted);
	if (total === null) return null;
	const want = total * target;
	const k = Math.floor(Math.log10(want));
	let best = 10 ** k;
	for (const m of [2, 5, 10]) if (m * 10 ** k <= want) best = m * 10 ** k;
	if (best / total > max) return null;
	return { fraction: best / total, label: scaleBarText(best) };
}
