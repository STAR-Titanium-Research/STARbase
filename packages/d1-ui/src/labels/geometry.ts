// Where each label sits on a page, and how a list of samples is spread over pages.
import type { LabelSample, LabelTemplate } from './types';

export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Slot {
	x: number;
	y: number;
}

// Top-left corner (mm) of every label on a page, row by row. The margins are explicit (a die-cut
// sheet is specified by them), so nothing is centred.
export function slotPositions(t: LabelTemplate): Slot[] {
	const out: Slot[] = [];
	for (let r = 0; r < t.rows; r++) {
		for (let c = 0; c < t.columns; c++) {
			out.push({
				x: round2(t.marginLeftMm + c * (t.labelWidthMm + t.gapXMm)),
				y: round2(t.marginTopMm + r * (t.labelHeightMm + t.gapYMm)),
			});
		}
	}
	return out;
}

export interface PaginateOptions {
	// Copies of every sample, printed next to each other. Whole number, 1 or more.
	copies: number;
	// 1-based slot on the first page of the first label, to reuse a part-used sheet. Ignored for a roll.
	start: number;
}

const wholeAtLeast = (n: number, min: number): number => (Number.isFinite(n) ? Math.max(min, Math.floor(n)) : min);

// Spread the samples (each repeated `copies` times) over pages of rows x columns slots. A skipped slot
// is null; only the first page has any, and a page is not padded after its last label. A roll
// (media 'roll', or any 1x1 template) has one label per page.
export function paginate(samples: LabelSample[], opts: PaginateOptions, t: LabelTemplate): (LabelSample | null)[][] {
	const perPage = Math.max(1, t.columns * t.rows);
	const copies = wholeAtLeast(opts.copies, 1);
	const skip = t.media === 'roll' || perPage === 1 ? 0 : Math.min(wholeAtLeast(opts.start, 1), perPage) - 1;

	const flat: (LabelSample | null)[] = Array(skip).fill(null);
	for (const s of samples) for (let i = 0; i < copies; i++) flat.push(s);
	if (flat.length === skip) return [];

	const pages: (LabelSample | null)[][] = [];
	for (let i = 0; i < flat.length; i += perPage) pages.push(flat.slice(i, i + perPage));
	return pages;
}
