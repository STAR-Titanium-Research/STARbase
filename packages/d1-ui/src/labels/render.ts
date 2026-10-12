// A standalone HTML document of label pages: the same output is the on-screen preview (iframe srcdoc)
// and what gets printed. White labels, black text, system fonts, absolute mm positions, an inline SVG
// QR code, no scripts and no external resources, so it prints the same anywhere and works offline.
import { slotPositions, round2 } from './geometry';
import { layoutLabel, type Box } from './layout';
import { buildQrPayload } from './qrPayload';
import { isPrintableSample } from './sample';
import { qrSvg, type QrModules } from './qrSvg';
import { chooseQr, wantedQrMm, WARN_MODULE_MM, type QrLevel } from './qrDensity';
import type { Measure } from './fit';
import type { LabelSample, LabelTemplate } from './types';

export interface RenderOptions {
	// Screen-only dashed outline round every label (and an amber one round a clipped label, with empty
	// slots shown ghosted). Never reaches the printer. Off by default: that is the print variant.
	outline?: boolean;
	// Exact text width in mm (for example from canvas measureText); the default is a per-character estimate.
	measure?: Measure;
	// The lab contact (label_settings.contact_email) for the QR payload's Contact line; none when null or empty.
	contactEmail?: string | null;
}

export interface RenderedLabels {
	html: string;
	// How many labels had a field cut off or dropped (not how many fields).
	clipped: number;
	// Samples left out because they have no code or no valid short id (see isPrintableSample). Their slot stays empty.
	invalid: number;
	// The smallest QR module on any label, in mm (null when no label has a QR code).
	qrModuleMm: number | null;
	// How many labels have QR modules under WARN_MODULE_MM even at the lowest error correction: a phone may not read them.
	qrDense: number;
}

// Nothing may load or run in the document: styles are inline, there are no scripts, and images may only be data.
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v: string): string => v.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const mm = (n: number): string => `${round2(n)}mm`;
const boxStyle = (b: Box): string => `left:${mm(b.x)};top:${mm(b.y)};width:${mm(b.w)};height:${mm(b.h)}`;

function css(t: LabelTemplate, outline: boolean): string {
	const rules = [
		'*{box-sizing:border-box;margin:0;padding:0}',
		`@page{size:${mm(t.pageWidthMm)} ${mm(t.pageHeightMm)};margin:0}`,
		'html,body{background:transparent}',
		'body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
		`.page{position:relative;overflow:hidden;background:#fff;width:${mm(t.pageWidthMm)};height:${mm(t.pageHeightMm)};break-after:page;page-break-after:always}`,
		'.page:last-child{break-after:auto;page-break-after:auto}',
		'.label{position:absolute;overflow:hidden;background:#fff;color:#000}',
		'.qr{position:absolute;background:#fff}',
		'.qr svg{display:block;width:100%;height:100%}',
		'.t{position:absolute;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
		'@media screen{.page{margin:0 auto 4mm;box-shadow:0 0 0 .2mm rgba(0,0,0,.15)}}',
	];
	if (outline) {
		rules.push(
			'@media screen{.label{outline:.2mm dashed #9ca3af;outline-offset:-.2mm}',
			'.label.clipped{outline:.5mm dashed #d97706;outline-offset:-.5mm}',
			'.slot-skipped{position:absolute;outline:.2mm dashed #d1d5db;outline-offset:-.2mm}}'
		);
	}
	return rules.join('\n');
}

// `encode` turns a payload and an error-correction level into a QR module matrix (the shape of
// `QRCode.create(payload, { errorCorrectionLevel }).modules`): M while the modules stay big enough, else L
// (see chooseQr). The SVG is
// drawn here, so no markup from the caller ever reaches the document, and all text is escaped.
export function renderLabelDocument(
	pages: (LabelSample | null)[][],
	t: LabelTemplate,
	encode: (payload: string, level: QrLevel) => QrModules,
	options: RenderOptions = {}
): RenderedLabels {
	// Each payload is encoded once per level for this document (the size wanted and the level chosen both ask).
	const memo = new Map<string, QrModules>();
	const qr = (payload: string, level: QrLevel): QrModules => {
		const key = level + " " + payload;
		let m = memo.get(key);
		if (!m) memo.set(key, (m = encode(payload, level)));
		return m;
	};
	const outline = options.outline === true;
	const slots = slotPositions(t);
	let clipped = 0;
	let count = 0;
	let invalid = 0;
	let minModuleMm: number | null = null;
	let dense = 0;

	const pageHtml = pages.map((page) => {
		const labels = page.map((sample, i) => {
			const slot = slots[i];
			if (!slot) return '';
			const frame = `left:${mm(slot.x)};top:${mm(slot.y)};width:${mm(t.labelWidthMm)};height:${mm(t.labelHeightMm)}`;
			if (sample && !isPrintableSample(sample)) invalid++;
			if (!sample || !isPrintableSample(sample)) return outline ? `<div class="slot-skipped" style="${frame}"></div>` : '';
			count++;
			const payload = t.arrangement === 'text_only' ? '' : buildQrPayload(sample, options.contactEmail ?? null, t.qrFields);
			const lay = layoutLabel(sample, t, options.measure, payload ? wantedQrMm(payload, qr) : 0);
			if (lay.clipped) clipped++;
			let qrBox = '';
			if (lay.qr) {
				const chosen = chooseQr(payload, Math.min(lay.qr.w, lay.qr.h), qr);
				minModuleMm = minModuleMm === null ? chosen.moduleMm : Math.min(minModuleMm, chosen.moduleMm);
				if (chosen.moduleMm < WARN_MODULE_MM) dense++;
				qrBox = `<div class="qr" style="${boxStyle(lay.qr)}">${qrSvg(chosen.modules)}</div>`;
			}
			const text = lay.lines
				.filter((l) => l.text !== '')
				.map(
					(l) =>
						`<div class="t" style="${boxStyle(l)};line-height:${mm(l.h)};font-size:${l.pt}pt;text-align:${l.align}${l.bold ? ';font-weight:700' : ''}">${esc(l.text)}</div>`
				)
				.join('');
			return `<div class="label${lay.clipped ? ' clipped' : ''}" style="${frame}">${qrBox}${text}</div>`;
		});
		return `<div class="page">${labels.join('')}</div>`;
	});

	const title = esc(`${t.name || 'Labels'} (${count} label${count === 1 ? '' : 's'})`);
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${css(t, outline)}
</style></head><body>
${pageHtml.join('\n')}
</body></html>`;
	return { html, clipped, invalid, qrModuleMm: minModuleMm === null ? null : round2(minModuleMm * 1000) / 1000, qrDense: dense };
}
