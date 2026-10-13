// Fit one line of text into a box of a given width. By default the width is estimated per character
// class (no canvas, so it runs in tests and in the print iframe alike); a caller in a browser can pass a
// `measure` function (for example canvas measureText) for exact widths. The labels also set
// `overflow: hidden` as a last line of defence.
import type { FieldSize } from './types';

// pt a field starts at, by size.
export const SIZE_PT: Record<FieldSize, number> = { lg: 14, md: 10, sm: 7 };
// The smallest it may shrink to before the text is cut with an ellipsis.
export const MIN_PT: Record<FieldSize, number> = { lg: 9, md: 6.5, sm: 5 };

export const MM_PER_PT = 25.4 / 72;
export const ELLIPSIS = '…';

// Width in mm of `text` set at `pt`. Must grow with the text and scale roughly linearly with pt.
export type Measure = (text: string, pt: number, bold: boolean) => number;

const BOLD_FACTOR = 1.08;
const NARROW = ["i", "l", ".", "'", "-", ",", ":", ";", "!", "|", " "];

// Average advance width in em of a character in a system sans-serif. Digits are tabular, so "1" is as
// wide as the others; the narrow class is for i, l and punctuation.
function charEm(ch: string): number {
	if (ch === 'M' || ch === 'W') return 0.85;
	if (ch >= 'A' && ch <= 'Z') return 0.68;
	if (ch >= '0' && ch <= '9') return 0.58;
	if (NARROW.includes(ch)) return 0.3;
	if (ch >= 'a' && ch <= 'z') return 0.52;
	return 0.6;
}

// Estimated width of `text` set at `pt`.
export function textWidthMm(text: string, pt: number, bold: boolean): number {
	let em = 0;
	for (const ch of text) em += charEm(ch);
	return em * (bold ? BOLD_FACTOR : 1) * pt * MM_PER_PT;
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
export function fitText(text: string, boxWidthMm: number, size: FieldSize, bold: boolean, measure: Measure = textWidthMm): FittedText {
	const base = SIZE_PT[size];
	const min = MIN_PT[size];
	const chars = Array.from(text);
	if (!chars.length) return { pt: base, clipped: false, text: '' };

	const atBase = measure(text, base, bold);
	if (atBase <= boxWidthMm) return { pt: base, clipped: false, text };
	const pt = floor1(boxWidthMm / (atBase / base));
	if (pt >= min) return { pt, clipped: false, text };

	// Longest prefix that still fits at the minimum size with the ellipsis (width grows with length).
	const cut = (n: number) => chars.slice(0, n).join('').trimEnd() + ELLIPSIS;
	let lo = 0;
	let hi = chars.length - 1;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (measure(cut(mid), min, bold) <= boxWidthMm) lo = mid;
		else hi = mid - 1;
	}
	if (lo < 1) return { pt: min, clipped: true, text: '' };
	return { pt: min, clipped: true, text: cut(lo) };
}
