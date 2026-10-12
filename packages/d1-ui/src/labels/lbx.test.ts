import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildLbxDownload, isLbxTemplate, lbxFileStem } from './lbxBundle';
import { buildLbxLabelXml, buildPropXml, chooseLbxQr, qrModuleCount, qrVersion, xmlText } from './lbx';
import { buildQrPayload } from './qrPayload';
import { templateFromRow } from './template';
import type { LabelSample } from './types';

const BROTHER = templateFromRow({
	name: 'Brother DK-22205', media: 'roll', page_width_mm: 62, page_height_mm: 30, columns: 1, rows: 1, label_width_mm: 62,
	label_height_mm: 30, arrangement: 'qr_left',
	fields: [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'short_id', size: 'md' }, { key: 'nickname', size: 'md' }],
});
const sample = (n: number, over: Partial<LabelSample> = {}): LabelSample => ({
	id: `id-${n}`, code: `S-${n}`, shortId: String(n).padStart(8, '0'), nickname: 'bracket A', material: 'Ti-6Al-4V', date: '2026-10-01', ownerInitials: 'DP',
	ownerEmail: 'dp@example.org', ...over,
});
const CONTACT = 'lab@example.org';
const parse = (xml: string): Document =>
	new DOMParser({ onError: (l, m) => { throw new Error(`${l}: ${m}`); } }).parseFromString(xml, 'text/xml') as unknown as Document;
const attr = (xml: string, tag: string, name: string): string => new RegExp(`<${tag}[^>]*?\\s${name}="([^"]*)"`).exec(xml)![1];
const objectBoxes = (xml: string): { x: number; y: number; w: number; h: number }[] =>
	[...xml.matchAll(/<pt:objectStyle x="([\d.]+)pt" y="([\d.]+)pt" width="([\d.]+)pt" height="([\d.]+)pt"/g)].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
const qrData = (xml: string): string => /<barcode:barcode>.*?<pt:data>([^<]*)<\/pt:data>/s.exec(xml)![1];

describe('buildLbxLabelXml', () => {
	const xml = buildLbxLabelXml(sample(1), BROTHER, CONTACT);

	it('is well-formed XML in the P-touch shape, with the declaration, CRLF and no BOM', () => {
		expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\r\n<pt:document xmlns:pt=')).toBe(true);
		expect(xml.charCodeAt(0)).not.toBe(0xfeff);
		const doc = parse(xml);
		expect(doc.documentElement.nodeName).toBe('pt:document');
		expect(doc.documentElement.getAttribute('version')).toBe('1.0');
		for (const n of ['main', 'style', 'text', 'draw', 'image', 'barcode', 'database', 'table']) {
			expect(xml).toContain(`http://schemas.brother.info/ptouch/2007/lbx/${n}"`);
		}
	});
	it('describes the 62 mm continuous roll, 30 mm long, as a portrait label', () => {
		const paper = /<style:paper[^>]*>/.exec(xml)![0];
		expect(paper).toContain('width="175.7pt"');
		expect(paper).toContain('height="85pt"');
		expect(paper).toContain('format="259"');
		expect(paper).toContain('orientation="portrait"');
		expect(paper).toContain('autoLength="false"');
		expect(paper).toContain('printerName="Brother QL-550"');
		expect(xml).toContain('<style:backGround x="4.3pt" y="8.4pt" width="167pt" height="68.2pt"');
	});
	it('has the QR object first, then the text objects in the template order', () => {
		const order = [...xml.matchAll(/<(barcode:barcode|text:text)>/g)].map((m) => m[1]);
		expect(order).toEqual(['barcode:barcode', 'text:text', 'text:text', 'text:text']);
		expect([...xml.matchAll(/<text:text>.*?<pt:data>(.*?)<\/pt:data>/g)].map((m) => m[1])).toEqual(['S-1', '00000001', 'bracket A']);
	});
	it('puts the payload in the QR with CRLF line breaks, model 2, level 15%', () => {
		expect(attr(xml, 'barcode:barcodeStyle', 'protocol')).toBe('QRCODE');
		expect(xml).toMatch(/<barcode:qrcodeStyle model="2" eccLevel="15%" cellSize="[\d.]+pt" mbcs="932" joint="1" version="auto"\/>/);
		expect(qrData(xml)).toContain('\r\n');
		expect(qrData(xml).replace(/\r\n/g, '\n')).toBe(buildQrPayload(sample(1), CONTACT, BROTHER.qrFields));
	});
	it('honours the template QR keys', () => {
		const t = { ...BROTHER, qrFields: ['date' as const] };
		expect(qrData(buildLbxLabelXml(sample(1), t, CONTACT)).replace(/\r\n/g, '\n')).toBe('D1 SAMPLE\nS-1 | 00000001\n2026-10-01');
	});
	it('maps bold to weight 700 and the field size to pt, with the text length in charLen', () => {
		const texts = [...xml.matchAll(/<text:text>.*?<\/text:text>/g)].map((m) => m[0]);
		expect(texts[0]).toContain('weight="700"');
		expect(texts[1]).toContain('weight="400"');
		for (const t of texts) {
			expect(t).toContain('orgSize="28.8pt"');
			expect(t).toContain('control="FIXEDFRAME"');
			const size = /size="([\d.]+)pt"/.exec(t)![1];
			expect(t).toContain(`orgPoint="${size}pt"`);
			expect(Number(size)).toBeGreaterThan(4);
			expect(Number(size)).toBeLessThanOrEqual(14);
		}
		expect(texts[0]).toContain('charLen="3"');
		expect(texts[2]).toContain('charLen="9"');
	});
	it('does not link any object to a merge field', () => {
		expect(xml).not.toContain('templateMergeType="FIELD"');
		expect(xml).toContain('templateMergeType="NONE"');
	});
	it('keeps every object inside the printable area of the label', () => {
		const boxes = objectBoxes(xml);
		expect(boxes.length).toBe(4);
		for (const b of boxes) {
			expect(b.x).toBeGreaterThanOrEqual(4.3 - 0.05);
			expect(b.x + b.w).toBeLessThanOrEqual(175.7 - 4.4 + 0.15);
			expect(b.y).toBeGreaterThanOrEqual(8.4 - 0.05);
			expect(b.y + b.h).toBeLessThanOrEqual(85 - 8.4 + 0.15);
		}
	});
	it('escapes the text of every object', () => {
		const out = buildLbxLabelXml(sample(2, { code: 'A&B<1>', nickname: 'x "y" & <z>', material: null }), BROTHER, CONTACT);
		parse(out);
		expect(out).toContain('<pt:data>A&amp;B&lt;1&gt;</pt:data>');
		expect(out).toContain('x "y" &amp; &lt;z&gt;');
		expect(out).not.toContain('A&B');
	});
	it('keeps non-ASCII text and drops characters XML cannot hold', () => {
		const out = buildLbxLabelXml(sample(3, { nickname: 'Mg-Zr é\u0001ü', material: null }), BROTHER, CONTACT);
		parse(out);
		expect(out).toContain('Mg-Zr éü');
	});
	it('counts a pair of UTF-16 units as the text length', () => {
		expect(buildLbxLabelXml(sample(3, { nickname: '😀' }), BROTHER, null)).toContain('charLen="2"');
	});
	it('has no text object for an empty field, and no QR for a text-only template', () => {
		const out = buildLbxLabelXml(sample(4, { nickname: null }), { ...BROTHER, arrangement: 'text_only' }, CONTACT);
		expect(out).not.toContain('<barcode:barcode>');
		expect((out.match(/<text:text>/g) ?? []).length).toBe(2);
	});
	it('takes the length from the template label height', () => {
		const out = buildLbxLabelXml(sample(1), { ...BROTHER, labelHeightMm: 40 }, CONTACT);
		expect(attr(out, 'style:paper', 'height')).toBe('113.4pt');
	});
});

describe('QR size', () => {
	it('estimates the version from the byte capacity', () => {
		expect(qrVersion(14, 'M')).toBe(1);
		expect(qrVersion(15, 'M')).toBe(2);
		expect(qrVersion(213, 'M')).toBe(10);
		expect(qrModuleCount(180, 'M')).toBe(17 + 4 * 9);
		expect(qrVersion(17, 'L')).toBe(1);
		expect(qrVersion(5000, 'M')).toBeGreaterThan(20);
	});
	it('picks whole printer dots, as big as the box allows', () => {
		const payload = buildQrPayload(sample(1), CONTACT);
		const big = chooseLbxQr(payload, 100);
		expect(big.level).toBe('M');
		const dots = big.cellPt / (72 / 300);
		expect(Math.abs(dots - Math.round(dots))).toBeLessThan(0.05);
		expect(big.sizePt).toBeLessThanOrEqual(100 + 1e-6);
		expect(chooseLbxQr(payload, 40).cellPt).toBeLessThan(big.cellPt);
	});
	it('drops to the 7% level when 15% would make the modules too small', () => {
		const payload = buildQrPayload(sample(1), CONTACT);
		expect(chooseLbxQr(payload, 40).level).toBe('L');
		expect(chooseLbxQr(payload, 5).cellPt).toBeCloseTo(0.72, 2);
	});
});

describe('buildPropXml', () => {
	it('is well-formed and carries the title', () => {
		const xml = buildPropXml('S-1 & co', new Date('2026-10-12T08:30:15.123Z'));
		parse(xml);
		expect(xml).toContain('<dc:title>S-1 &amp; co</dc:title>');
		expect(xml).toContain('<dcterms:created>2026-10-12T08:30:15Z</dcterms:created>');
		expect(xml).toContain('<meta:numPages>1</meta:numPages>');
	});
});

describe('xmlText', () => {
	it('escapes and cleans', () => {
		expect(xmlText('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d');
		expect(xmlText('a\u0000b\uD800c')).toBe('abc');
	});
});

describe('isLbxTemplate', () => {
	it('is a roll as wide as the 62 mm tape', () => {
		expect(isLbxTemplate(BROTHER)).toBe(true);
		expect(isLbxTemplate({ ...BROTHER, labelWidthMm: 62.4 })).toBe(true);
		expect(isLbxTemplate({ ...BROTHER, labelWidthMm: 50 })).toBe(false);
		expect(isLbxTemplate({ ...BROTHER, media: 'sheet' })).toBe(false);
		expect(isLbxTemplate(null)).toBe(false);
	});
});

describe('buildLbxDownload', () => {
	const now = new Date(2026, 9, 12, 9, 0, 0);

	it('is a bare .lbx for one label: a zip of label.xml then prop.xml', () => {
		const d = buildLbxDownload([{ sample: sample(1), copies: 1 }], BROTHER, CONTACT, now)!;
		expect(d.filename).toBe('S-1.lbx');
		expect(d.labels).toBe(1);
		expect(Array.from(d.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
		const files = unzipSync(d.bytes);
		expect(Object.keys(files)).toEqual(['label.xml', 'prop.xml']);
		expect(strFromU8(files['label.xml'])).toBe(buildLbxLabelXml(sample(1), BROTHER, CONTACT));
		expect(strFromU8(files['prop.xml'])).toContain('<dc:title>S-1</dc:title>');
		expect(files['label.xml'][0]).toBe(0x3c);
		// deflated, as P-touch's own files are (method 8 in the first local header)
		expect(d.bytes[8]).toBe(8);
	});
	it('is a zip of one .lbx per label copy, named <code>-<n>.lbx', () => {
		const d = buildLbxDownload([{ sample: sample(1), copies: 2 }, { sample: sample(2), copies: 1 }], BROTHER, CONTACT, now)!;
		expect(d.filename).toBe('labels-2026-10-12.zip');
		expect(d.mime).toBe('application/zip');
		expect(d.labels).toBe(3);
		const outer = unzipSync(d.bytes);
		expect(Object.keys(outer)).toEqual(['S-1-1.lbx', 'S-1-2.lbx', 'S-2-1.lbx']);
		expect(Object.keys(unzipSync(outer['S-2-1.lbx']))).toEqual(['label.xml', 'prop.xml']);
	});
	it('makes a bare .lbx of one sample with one copy, and a zip of one sample with copies', () => {
		expect(buildLbxDownload([{ sample: sample(1), copies: 1 }], BROTHER, null, now)!.filename).toBe('S-1.lbx');
		expect(buildLbxDownload([{ sample: sample(1), copies: 3 }], BROTHER, null, now)!.filename).toBe('labels-2026-10-12.zip');
	});
	it('skips samples that cannot be printed and counts them', () => {
		const d = buildLbxDownload([{ sample: sample(1, { shortId: 'nope' }), copies: 1 }, { sample: sample(2), copies: 1 }], BROTHER, null, now)!;
		expect(d.filename).toBe('S-2.lbx');
		expect(d.invalid).toBe(1);
		expect(buildLbxDownload([{ sample: sample(1, { code: ' ' }), copies: 1 }], BROTHER, null, now)).toBeNull();
		expect(buildLbxDownload([], BROTHER, null, now)).toBeNull();
	});
	it('keeps file names unique and safe', () => {
		expect(lbxFileStem('A/B:C*D?')).toBe('A_B_C_D');
		expect(lbxFileStem('..')).toBe('label');
		const d = buildLbxDownload([{ sample: sample(1, { code: 'A/B' }), copies: 1 }, { sample: sample(2, { code: 'A:B' }), copies: 1 }], BROTHER, null, now)!;
		expect(Object.keys(unzipSync(d.bytes))).toEqual(['A_B-1.lbx', 'A_B-1_2.lbx']);
	});
});
