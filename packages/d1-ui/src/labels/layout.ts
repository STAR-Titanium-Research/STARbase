// Where the QR code and each text line go inside one label (mm, relative to the label's top-left
// corner), and which lines had to be cut. Pure arithmetic; render.ts turns it into HTML.
import { fitText, MM_PER_PT } from './fit';
import { round2 } from './geometry';
import { fieldValue, type LabelSample, type LabelTemplate } from './types';

export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface TextLine extends Box {
	text: string;
	pt: number;
	bold: boolean;
	align: 'left' | 'center';
}

export interface LabelLayout {
	qr: Box | null;
	lines: TextLine[];
	// true when a line was cut with "..." or dropped because the label ran out of height
	clipped: boolean;
}

// Line height as a multiple of the font size.
export const LINE_HEIGHT = 1.2;
// Space between the QR code and the text.
const GAP_MM = 1;
// With an automatic QR size the text keeps at least this share of the label's width (qr_left)...
const TEXT_SHARE_LEFT = 0.45;
// ...and the QR code is never smaller than this share of the label's shorter inner side (qr_top).
const MIN_QR_SHARE = 0.35;

interface Fitted {
	text: string;
	pt: number;
	bold: boolean;
	h: number;
}

const lineHeightMm = (pt: number) => pt * MM_PER_PT * LINE_HEIGHT;

function fitLines(s: LabelSample, t: LabelTemplate, widthMm: number): { lines: Fitted[]; clipped: boolean } {
	const lines: Fitted[] = [];
	let clipped = false;
	for (const f of t.fields) {
		const value = fieldValue(s, f.key).trim();
		if (!value) continue;
		const r = fitText(value, widthMm, f.size, f.bold);
		if (r.clipped) clipped = true;
		lines.push({ text: r.text, pt: r.pt, bold: f.bold, h: lineHeightMm(r.pt) });
	}
	return { lines, clipped };
}

// Keep the lines that fit in `heightMm`, in order; the rest are dropped.
function fitHeight(lines: Fitted[], heightMm: number): { kept: Fitted[]; dropped: boolean } {
	const kept: Fitted[] = [];
	let used = 0;
	for (const l of lines) {
		if (used + l.h > heightMm + 0.01) return { kept, dropped: true };
		kept.push(l);
		used += l.h;
	}
	return { kept, dropped: false };
}

const sum = (lines: Fitted[]) => lines.reduce((n, l) => n + l.h, 0);

function stack(lines: Fitted[], x: number, y: number, w: number, align: TextLine['align']): TextLine[] {
	let top = y;
	return lines.map((l) => {
		const line: TextLine = { text: l.text, pt: l.pt, bold: l.bold, align, x: round2(x), y: round2(top), w: round2(w), h: round2(l.h) };
		top += l.h;
		return line;
	});
}

export function layoutLabel(s: LabelSample, t: LabelTemplate): LabelLayout {
	const p = t.paddingMm;
	const innerW = t.labelWidthMm - 2 * p;
	const innerH = t.labelHeightMm - 2 * p;
	const explicit = t.qrSizeMm !== null && t.qrSizeMm > 0 ? t.qrSizeMm : null;

	if (t.arrangement === 'text_only') {
		const fit = fitLines(s, t, innerW);
		const { kept, dropped } = fitHeight(fit.lines, innerH);
		const top = p + (innerH - sum(kept)) / 2;
		return { qr: null, lines: stack(kept, p, top, innerW, 'center'), clipped: fit.clipped || dropped };
	}

	if (t.arrangement === 'qr_top') {
		const fit = fitLines(s, t, innerW);
		const side = Math.min(innerW, innerH);
		let q: number;
		if (explicit !== null) q = Math.min(explicit, side);
		else if (!fit.lines.length) q = side;
		else q = Math.min(innerW, Math.max(innerH - sum(fit.lines) - GAP_MM, side * MIN_QR_SHARE));
		const { kept, dropped } = fitHeight(fit.lines, Math.max(0, innerH - q - GAP_MM));
		const textH = sum(kept);
		const groupH = q + (kept.length ? GAP_MM + textH : 0);
		const top = p + (innerH - groupH) / 2;
		return {
			qr: { x: round2(p + (innerW - q) / 2), y: round2(top), w: round2(q), h: round2(q) },
			lines: stack(kept, p, top + q + GAP_MM, innerW, 'center'),
			clipped: fit.clipped || dropped,
		};
	}

	// qr_left
	const side = Math.min(innerW, innerH);
	const probe = fitLines(s, t, 0); // only to know whether there is any text at all
	let q: number;
	if (explicit !== null) q = Math.min(explicit, side);
	else if (!probe.lines.length) q = side;
	else q = Math.min(innerH, innerW * (1 - TEXT_SHARE_LEFT));
	const textW = Math.max(0, innerW - q - GAP_MM);
	const fit = fitLines(s, t, textW);
	const { kept, dropped } = fitHeight(fit.lines, innerH);
	return {
		qr: { x: round2(p), y: round2(p + (innerH - q) / 2), w: round2(q), h: round2(q) },
		lines: stack(kept, p + q + GAP_MM, p + (innerH - sum(kept)) / 2, textW, 'left'),
		clipped: fit.clipped || dropped,
	};
}
