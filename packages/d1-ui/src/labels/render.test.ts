import { describe, expect, it } from 'vitest';
import { paginate } from './geometry';
import { layoutLabel } from './layout';
import { renderLabelDocument } from './render';
import { templateFromRow } from './template';
import type { LabelSample, LabelTemplate } from './types';

const A4_4X5 = templateFromRow({
	name: 'A4 4×5', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 4, rows: 5, label_width_mm: '52.5',
	label_height_mm: '59.4', arrangement: 'qr_top',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm', bold: false }],
});
const L7160 = templateFromRow({
	name: 'L7160', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 3, rows: 7, label_width_mm: '63.5',
	label_height_mm: '38.1', margin_top_mm: '15.15', margin_left_mm: '7.25', gap_x_mm: '2.54', arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'material', size: 'md' }],
});
const BROTHER = templateFromRow({
	name: 'Brother DK-22205', media: 'roll', page_width_mm: 62, page_height_mm: 30, columns: 1, rows: 1, label_width_mm: 62,
	label_height_mm: 30, arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'short_id', size: 'md' }, { key: 'nickname', size: 'md' }],
});

const sample = (n: number, over: Partial<LabelSample> = {}): LabelSample => ({
	id: `id-${n}`, code: `S-${n}`, shortId: String(n).padStart(8, '0'), nickname: null, material: null, date: null, ownerInitials: null, ...over,
});
const FAKE_QR = (_payload: string) => ({ size: 2, data: [1, 0, 0, 1] });
const render = (samples: LabelSample[], t: LabelTemplate, opts?: { outline?: boolean }, start = 1) =>
	renderLabelDocument(paginate(samples, { copies: 1, start }, t), t, FAKE_QR, opts);

describe('renderLabelDocument', () => {
	it('is a full document with the page size and zero margin', () => {
		const { html } = render([sample(1)], A4_4X5);
		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html).toContain('@page{size:210mm 297mm;margin:0}');
		expect(html).toContain('<meta charset="utf-8">');
	});
	it('uses the roll size for a roll', () => {
		expect(render([sample(1)], BROTHER).html).toContain('@page{size:62mm 30mm;margin:0}');
	});
	it('places labels at absolute mm positions (L7160 margins and gap)', () => {
		const { html } = render([1, 2, 3, 4].map((n) => sample(n)), L7160);
		expect(html).toContain('left:7.25mm;top:15.15mm;width:63.5mm;height:38.1mm');
		expect(html).toContain('left:73.29mm;top:15.15mm');
		expect(html).toContain('left:139.33mm;top:15.15mm');
		expect(html).toContain('left:7.25mm;top:53.25mm');
		expect(html).not.toMatch(/\d\.\d{3,}mm/);
	});
	it('makes one page per sheet and one per label on a roll', () => {
		const many = Array.from({ length: 21 }, (_, i) => sample(i + 1));
		expect(render(many, A4_4X5).html.match(/class="page"/g)).toHaveLength(2);
		expect(render([sample(1), sample(2), sample(3)], BROTHER).html.match(/class="page"/g)).toHaveLength(3);
	});
	it('prints white labels with black text in system fonts', () => {
		const { html } = render([sample(1)], A4_4X5);
		expect(html).toMatch(/\.label\{[^}]*background:#fff;color:#000/);
		expect(html).toContain('font-family:system-ui');
		expect(html).not.toContain('@font-face');
		expect(html).not.toMatch(/prefers-color-scheme/);
	});
	it('has a restrictive CSP right after the charset meta', () => {
		const { html } = render([sample(1)], A4_4X5);
		expect(html).toContain(
			'<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">'
		);
	});
	it('never inserts markup from the caller: a nickname that tries to close the svg shows only escaped', () => {
		const t = { ...A4_4X5, qrFields: ['nickname' as const] };
		const nasty = '</svg><script>x</script>';
		const { html } = renderLabelDocument(paginate([sample(1, { nickname: nasty })], { copies: 1, start: 1 }, t), t, FAKE_QR);
		expect(html).not.toContain('<script');
		expect(html).not.toContain('</svg><script');
		expect(html).toContain('&lt;/svg&gt;&lt;script&gt;x&lt;/script&gt;');
	});
	it('draws the QR itself from the modules the callback returns', () => {
		const { html } = renderLabelDocument(paginate([sample(1)], { copies: 1, start: 1 }, A4_4X5), A4_4X5, () => ({ size: 2, data: [1, 1, 0, 1] }));
		expect(html).toContain('M2 2h2v1h-2zM3 3h1v1h-1z');
	});
	it('has no external resources and no scripts', () => {
		const { html } = render([sample(1, { nickname: 'x', material: 'y' })], A4_4X5);
		expect(html).not.toMatch(/<script|<link|@import|url\(|<img|<iframe|\bsrc=|\bhref=|https?:/i);
	});
	it('inlines the QR from the callback, built from the payload with the template qrFields', () => {
		const seen: string[] = [];
		const t = { ...A4_4X5, qrFields: ['nickname' as const] };
		const { html } = renderLabelDocument(paginate([sample(1, { nickname: 'bracket' })], { copies: 1, start: 1 }, t), t, (p) => {
			seen.push(p);
			return { size: 1, data: [1] };
		});
		expect(seen).toEqual(['D1 SAMPLE\nS-1 · 00000001\n"bracket"']);
		expect(html).toContain('<div class="qr" style="');
		expect(html).toContain('<svg viewBox="0 0 5 5"');
	});
	it('draws no QR for a text-only template', () => {
		const t = { ...A4_4X5, arrangement: 'text_only' as const };
		let calls = 0;
		const { html } = renderLabelDocument(paginate([sample(1)], { copies: 1, start: 1 }, t), t, () => (calls++, { size: 1, data: [1] }));
		expect(calls).toBe(0);
		expect(html).not.toContain('class="qr"');
		expect(html).toContain('S-1');
	});
	it('escapes sample and template text, including the title', () => {
		const evil = '<img>&"q"\'s\'';
		const t = { ...A4_4X5, name: '<b>tpl</b>' };
		const { html } = renderLabelDocument(
			paginate([sample(1, { code: evil, nickname: '</div><script>1</script>' })], { copies: 1, start: 1 }, t),
			t,
			FAKE_QR
		);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('<b>tpl');
		expect(html).toContain('&lt;b&gt;tpl&lt;/b&gt; (1 label)');
		expect(html).toContain('&amp;');
		expect(html).toContain('&quot;');
		expect(html).toContain('&#39;');
		expect(html).toContain('&lt;img&gt;');
	});
	it('renders bold and size per field, skipping fields a sample has no value for', () => {
		const t = { ...A4_4X5, fields: [...A4_4X5.fields, { key: 'material' as const, size: 'md' as const, bold: false }] };
		const { html } = render([sample(1, { nickname: 'nick' })], t);
		expect(html).toMatch(/font-size:14pt;text-align:center;font-weight:700">S-1</);
		expect(html).toMatch(/font-size:7pt;text-align:center">nick</);
		expect(html).not.toContain('font-size:10pt');
	});
	it('reports a 36-character run of wide capitals as a clipped label on A4', () => {
		expect(render([sample(1, { code: 'W'.repeat(36) })], A4_4X5).clipped).toBe(1);
	});
	it('takes a measure function through the options', () => {
		const code = '1234-AA-MM-2026-10-12';
		expect(render([sample(1, { code })], BROTHER).clipped).toBe(0);
		const huge = renderLabelDocument(paginate([sample(1, { code })], { copies: 1, start: 1 }, BROTHER), BROTHER, FAKE_QR, { measure: () => 500 });
		expect(huge.clipped).toBe(1);
	});
	it('counts clipped labels (not fields) and cuts with an ellipsis', () => {
		const long = 'A nickname that is far too long to fit across a 62 mm label even at the smallest size';
		const r = render([sample(1, { nickname: long }), sample(2), sample(3, { nickname: long })], BROTHER);
		expect(r.clipped).toBe(2);
		expect(r.html).toContain('…');
		expect(r.html).not.toContain(long);
	});
	it('counts a label whose lines run out of height as clipped', () => {
		const t = templateFromRow({
			name: 'Tiny', media: 'roll', page_width_mm: 30, page_height_mm: 10, columns: 1, rows: 1, label_width_mm: 30, label_height_mm: 10,
			padding_mm: 1, arrangement: 'text_only',
			fields: ['sample_code', 'short_id', 'material', 'date'].map((key) => ({ key, size: 'lg', bold: false })),
		});
		const r = render([sample(1, { material: 'm', date: '2026-01-01' })], t);
		expect(r.clipped).toBe(1);
	});
	it('shows the outline and clipped flag on screen only when asked', () => {
		const long = 'x'.repeat(200);
		const off = render([sample(1, { nickname: long })], BROTHER);
		const on = render([sample(1, { nickname: long })], BROTHER, { outline: true });
		expect(off.html).not.toContain('outline');
		expect(off.html).not.toMatch(/@media screen\{\.label/);
		expect(on.html).toMatch(/@media screen\{\.label\{outline:/);
		expect(on.html).toContain('class="label clipped"');
		expect(on.clipped).toBe(off.clipped);
	});
	it('leaves skipped slots empty for print and ghosted in the preview', () => {
		const printed = render([sample(1)], A4_4X5, undefined, 3);
		expect(printed.html.match(/class="label/g)).toHaveLength(1);
		expect(printed.html).not.toContain('slot-skipped"');
		const preview = render([sample(1)], A4_4X5, { outline: true }, 3);
		expect(preview.html.match(/class="slot-skipped"/g)).toHaveLength(2);
	});
	it('renders an empty document for no pages', () => {
		const r = renderLabelDocument([], A4_4X5, FAKE_QR);
		expect(r.clipped).toBe(0);
		expect(r.html).toContain('A4 4×5 (0 labels)');
		expect(r.html).not.toContain('class="page"');
	});
});

describe('layoutLabel', () => {
	it('keeps the QR and text inside the padded label, for every arrangement', () => {
		const s = sample(1, { nickname: 'bracket A', material: 'Ti-6Al-4V', date: '2026-10-01', ownerInitials: 'DP' });
		const full = (t: LabelTemplate): LabelTemplate => ({
			...t, fields: ['sample_code', 'short_id', 'nickname', 'material', 'date', 'owner_initials'].map((key) => ({ key, size: 'sm', bold: false })) as LabelTemplate['fields'],
		});
		for (const base of [A4_4X5, L7160, BROTHER]) {
			for (const arrangement of ['qr_top', 'qr_left', 'text_only'] as const) {
				const t = full({ ...base, arrangement });
				const lay = layoutLabel(s, t);
				const inside = (b: { x: number; y: number; w: number; h: number }) => {
					expect(b.x).toBeGreaterThanOrEqual(t.paddingMm - 0.01);
					expect(b.y).toBeGreaterThanOrEqual(t.paddingMm - 0.01);
					expect(b.x + b.w).toBeLessThanOrEqual(t.labelWidthMm - t.paddingMm + 0.01);
					expect(b.y + b.h).toBeLessThanOrEqual(t.labelHeightMm - t.paddingMm + 0.01);
				};
				if (lay.qr) inside(lay.qr);
				lay.lines.forEach(inside);
				expect(Boolean(lay.qr)).toBe(arrangement !== 'text_only');
			}
		}
	});
	it('sizes an automatic QR as the largest square that leaves room for the text', () => {
		const lay = layoutLabel(sample(1, { nickname: 'n' }), A4_4X5);
		// inner box 48.5 x 55.4; code 14pt + nickname 7pt lines and a 1 mm gap sit below the QR
		expect(lay.qr!.w).toBeCloseTo(lay.qr!.h, 5);
		expect(lay.qr!.w).toBeGreaterThan(40);
		expect(lay.qr!.w).toBeLessThanOrEqual(48.5);
		const textTop = lay.lines[0].y;
		expect(textTop).toBeGreaterThanOrEqual(lay.qr!.y + lay.qr!.h);
	});
	it('honours an explicit QR size', () => {
		const lay = layoutLabel(sample(1), { ...A4_4X5, qrSizeMm: 20 });
		expect(lay.qr!.w).toBe(20);
		expect(lay.qr!.x).toBeCloseTo(2 + (48.5 - 20) / 2, 5);
	});
	it('puts the QR on the left and the text to its right for qr_left', () => {
		const lay = layoutLabel(sample(1, { nickname: 'n' }), BROTHER);
		expect(lay.qr!.x).toBe(2);
		expect(lay.lines[0].x).toBeGreaterThan(lay.qr!.x + lay.qr!.w);
		expect(lay.lines[0].align).toBe('left');
	});
});
