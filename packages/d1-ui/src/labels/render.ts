// A standalone HTML document of label pages: the same output is the on-screen preview (iframe srcdoc)
// and what gets printed. White labels, black text, system fonts, absolute mm positions, an inline SVG
// QR code, no scripts and no external resources, so it prints the same anywhere and works offline.
import { slotPositions, round2 } from './geometry';
import { layoutLabel, type Box } from './layout';
import { buildQrPayload } from './qrPayload';
import type { Measure } from './fit';
import type { LabelSample, LabelTemplate } from './types';

export interface RenderOptions {
	// Screen-only dashed outline round every label (and an amber one round a clipped label, with empty
	// slots shown ghosted). Never reaches the printer. Off by default: that is the print variant.
	outline?: boolean;
	// Exact text width in mm (for example from canvas measureText); the default is a per-character estimate.
	measure?: Measure;
}

export interface RenderedLabels {
	html: string;
	// How many labels had a field cut off or dropped (not how many fields).
	clipped: number;
}

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

// `qrSvg` turns a payload into an inline <svg>. Its result is inserted as is, so it must come from a QR
// library you trust; everything else (sample text, template name) is escaped.
export function renderLabelDocument(
	pages: (LabelSample | null)[][],
	t: LabelTemplate,
	qrSvg: (payload: string) => string,
	options: RenderOptions = {}
): RenderedLabels {
	const outline = options.outline === true;
	const slots = slotPositions(t);
	let clipped = 0;
	let count = 0;

	const pageHtml = pages.map((page) => {
		const labels = page.map((sample, i) => {
			const slot = slots[i];
			if (!slot) return '';
			const frame = `left:${mm(slot.x)};top:${mm(slot.y)};width:${mm(t.labelWidthMm)};height:${mm(t.labelHeightMm)}`;
			if (!sample) return outline ? `<div class="slot-skipped" style="${frame}"></div>` : '';
			count++;
			const lay = layoutLabel(sample, t, options.measure);
			if (lay.clipped) clipped++;
			const qr = lay.qr ? `<div class="qr" style="${boxStyle(lay.qr)}">${qrSvg(buildQrPayload(sample, t.qrFields))}</div>` : '';
			const text = lay.lines
				.filter((l) => l.text !== '')
				.map(
					(l) =>
						`<div class="t" style="${boxStyle(l)};line-height:${mm(l.h)};font-size:${l.pt}pt;text-align:${l.align}${l.bold ? ';font-weight:700' : ''}">${esc(l.text)}</div>`
				)
				.join('');
			return `<div class="label${lay.clipped ? ' clipped' : ''}" style="${frame}">${qr}${text}</div>`;
		});
		return `<div class="page">${labels.join('')}</div>`;
	});

	const title = esc(`${t.name || 'Labels'} (${count} label${count === 1 ? '' : 's'})`);
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${css(t, outline)}
</style></head><body>
${pageHtml.join('\n')}
</body></html>`;
	return { html, clipped };
}
