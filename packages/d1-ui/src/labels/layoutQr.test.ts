import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { paginate } from './geometry';
import { layoutLabel } from './layout';
import { buildQrPayload } from './qrPayload';
import { MIN_MODULE_MM, WARN_MODULE_MM, moduleMm, type QrLevel } from './qrDensity';
import { renderLabelDocument } from './render';
import { templateFromRow } from './template';
import type { LabelSample } from './types';

// The real encoder, as the labels page uses it.
const qr = (payload: string, level: QrLevel) => {
	const { size, data } = QRCode.create(payload, { errorCorrectionLevel: level }).modules;
	return { size, data };
};

// The 50 x 25 single seed of the label_templates migration.
const SINGLE_50X25 = templateFromRow({
	name: '50×25 single', media: 'roll', page_width_mm: 50, page_height_mm: 25, columns: 1, rows: 1, label_width_mm: 50, label_height_mm: 25,
	arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'md', bold: true }, { key: 'nickname', size: 'sm', bold: false }],
});
const A4_4X5 = templateFromRow({
	name: 'A4 4×5', media: 'sheet', page_width_mm: 210, page_height_mm: 297, columns: 4, rows: 5, label_width_mm: 52.5, label_height_mm: 59.4,
	arrangement: 'qr_top', fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm', bold: false }],
});
const DK_22205 = templateFromRow({
	name: 'DK-22205', media: 'roll', page_width_mm: 62, page_height_mm: 30, columns: 1, rows: 1, label_width_mm: 62, label_height_mm: 30,
	arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'short_id', size: 'md', bold: false }, { key: 'nickname', size: 'sm', bold: false }],
});

// A long code and Sheffield-length emails: the worst case the QR will really carry.
const LONG: LabelSample = {
	id: '1fc30b0f-f8b2-5226-b20e-f0c805278ddf', code: '1234-AG-MF-2026-10-12-AB', shortId: '1fc30b0f', nickname: 'FAST Control bar, cylinder',
	material: 'Ti-6Al-4V', date: '2026-10-12', ownerInitials: 'DP', ownerEmail: 'dennis.premoli2@sheffield.ac.uk',
};
const CONTACT = 'chemicals.workshop@sheffield.ac.uk';

describe('QR size against density, with the real qrcode encoder', () => {
	it('uses a payload of about 180 characters', () => {
		expect(LONG.code).toHaveLength(24);
		const n = buildQrPayload(LONG, CONTACT).length;
		expect(n).toBeGreaterThan(170);
		expect(n).toBeLessThan(200);
	});
	it('keeps the 50×25 seed readable (modules >= 0.3 mm) for a long code and long emails', () => {
		const out = renderLabelDocument(paginate([LONG], { copies: 1, start: 1 }, SINGLE_50X25), SINGLE_50X25, qr, { contactEmail: CONTACT });
		expect(out.qrModuleMm).toBeGreaterThanOrEqual(WARN_MODULE_MM);
		expect(out.qrDense).toBe(0);
	});
	it('grows an automatic QR to the inner height and flags the text it squeezes, instead of shrinking the code', () => {
		const lay = layoutLabel(LONG, SINGLE_50X25, undefined, 21);
		expect(lay.qr?.h).toBe(21); // the whole inner height: 25 mm less 2 x 2 mm padding
		expect(lay.clipped).toBe(true); // the code and nickname now have 24 mm and are flagged
		const small = layoutLabel(LONG, SINGLE_50X25); // no demand: the long code takes the width, the QR is left small
		expect(small.qr!.h).toBeLessThan(lay.qr!.h);
	});
	it('keeps an explicit QR size', () => {
		const t = { ...SINGLE_50X25, qrSizeMm: 12 };
		expect(layoutLabel(LONG, t, undefined, 21).qr?.h).toBe(12);
	});
	it('leaves A4 4×5 and the DK-22205 roll at M with comfortable modules', () => {
		for (const t of [A4_4X5, DK_22205]) {
			const out = renderLabelDocument(paginate([LONG], { copies: 1, start: 1 }, t), t, qr, { contactEmail: CONTACT });
			expect(out.qrModuleMm, t.name).toBeGreaterThanOrEqual(MIN_MODULE_MM);
			expect(out.qrDense, t.name).toBe(0);
		}
	});
	it('computes the module size from the real module count', () => {
		const m = qr(buildQrPayload(LONG, CONTACT), 'M');
		expect(moduleMm(21, m.size)).toBeCloseTo(21 / (m.size + 4), 6);
	});
});
