// Fit one line of text into a box of a given width. Pure arithmetic (no canvas, so it runs in tests and
// in the print iframe alike): glyph width is an average em fraction of a bold or regular system
// sans-serif, rounded up a little so a line never overflows its box in practice. The labels also set
// `overflow: hidden` as a last line of defence.
import type { FieldSize } from './types';

// pt a field starts at, by size.
export const SIZE_PT: Record<FieldSize, number> = { lg: 14, md: 10, sm: 7 };
// The smallest it may shrink to before the text is cut with an ellipsis.
export const MIN_PT: Record<FieldSize, number> = { lg: 9, md: 6.5, sm: 5 };

export const MM_PER_PT = 25.4 / 72;
const EM_REGULAR = 0.56;
const EM_BOLD = 0.62;
export const ELLIPSIS = '…';

const em = (bold: boolean) => (bold ? EM_BOLD : EM_REGULAR);

// Estimated width of `text` set at `pt`.
export function textWidthMm(text: string, pt: number, bold: boolean): number {
	return Array.from(text).length * em(bold) * pt * MM_PER_PT;
}

export interface FittedText {
	pt: number;
	// true only when the text was cut (shrinking alone does not count)
	clipped: boolean;
	text: string;
}

const floor1 = (n: number) => Math.floor(n * 10 + 1e-9) / 10;

// Shrink from the size's base pt down to its minimum; if it still does not fit, cut it at the minimum
// and end it with "…".
export function fitText(text: string, boxWidthMm: number, size: FieldSize, bold: boolean): FittedText {
	const base = SIZE_PT[size];
	const min = MIN_PT[size];
	const chars = Array.from(text);
	if (!chars.length) return { pt: base, clipped: false, text: '' };

	const perPt = chars.length * em(bold) * MM_PER_PT; // width per pt
	if (perPt * base <= boxWidthMm) return { pt: base, clipped: false, text };
	const pt = floor1(boxWidthMm / perPt);
	if (pt >= min) return { pt, clipped: false, text };

	const room = Math.floor(boxWidthMm / (em(bold) * min * MM_PER_PT)) - 1; // glyphs that fit, minus the ellipsis
	if (room < 1) return { pt: min, clipped: true, text: '' };
	return { pt: min, clipped: true, text: chars.slice(0, room).join('').trimEnd() + ELLIPSIS };
}
