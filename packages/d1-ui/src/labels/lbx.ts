// A Brother P-touch Editor label (.lbx) for one sample, for the QL-700 with the DK-22205 62 mm continuous roll.
//
// An .lbx is a zip of `label.xml` and `prop.xml`. Brother publishes no spec: the element order, attributes and
// values here are copied from the sample files that ship with P-touch Editor 5.4 (LayoutStyle\Roll\... and
// Template\Roll\..., QL-550 and QL-1050 rolls). The pieces that have no QL-700 sample (printerID, the format
// of a portrait continuous label) use the QL-550 values for the same 62 mm roll; P-touch Editor re-targets
// the label to the printer chosen there. See docs/research/2026-10-12-brother-lbx.md.
//
// The label is laid out in the same boxes as the preview and the print (layoutLabel), as a portrait label:
// the 62 mm side runs across the tape and the template's label height is the length along the feed, which is
// how the browser prints the same template on the roll.
//
// Pure: no zip here (see lbxBundle.ts), no Vue, no Directus.
import { MM_PER_PT } from './fit';
import { layoutLabel } from './layout';
import { buildQrPayload } from './qrPayload';
import type { LabelSample, LabelTemplate } from './types';

export const LBX_TAPE_MM = 62;
// 62 mm in pt, as P-touch writes it for the 62 mm tape.
const PAPER_WIDTH_PT = 175.7;
// QL-550 printer id and the 62 mm continuous format code (every QL-550 sample of this roll has them).
const PRINTER_ID = '20272';
const PRINTER_NAME = 'Brother QL-550';
const FORMAT_62_CONTINUOUS = '259';
// Margins P-touch gives this tape: across the tape (left, right) and along the feed (top, bottom).
const MARGIN_ACROSS_L = 4.3;
const MARGIN_ACROSS_R = 4.4;
const MARGIN_ALONG = 8.4;
// P-touch's own constant for every text object, whatever its size.
const ORG_SIZE_PT = 28.8;
const FONT = 'Arial';

// P-touch Editor only honours these QR cell sizes (pt per module); any other value is silently replaced by 1.6
// (checked in Editor 5.4: 0.72, 0.96 and 1.6 all came out as 1.6). The QL-700 prints 300 dpi, so 0.8 is about 3 dots.
export const CELL_STEPS_PT = [2.4, 2.0, 1.6, 1.2, 0.8];
// The 15% level is kept while a module is at least the preview's 0.33 mm (0.935 pt), else 7% (as chooseQr does).
const MIN_CELL_M_PT = 0.33 / MM_PER_PT;
// Light modules round the code, in modules (P-touch draws the same margin as qrSvg's quiet zone).
const QUIET = 2;

// Data capacity in bytes per QR version (1 to 20), byte mode, for the 15% (M) and 7% (L) levels: enough to
// estimate the size P-touch will draw (version "auto"). Beyond the table, 16 more bytes per version.
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666];
const CAPACITY_L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520, 586, 644, 718, 792, 858];

const NS = [
	['pt', 'main'], ['style', 'style'], ['text', 'text'], ['draw', 'draw'], ['image', 'image'], ['barcode', 'barcode'], ['database', 'database'], ['table', 'table'],
]
	.map(([p, n]) => `xmlns:${p}="http://schemas.brother.info/ptouch/2007/lbx/${n}"`)
	.join(' ');

// P-touch's own files put CRLF after the XML declaration and keep the rest on one line.
const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\r\n';

// Element text: XML-escaped, and without the characters XML cannot hold (control characters, lone surrogates).
export function xmlText(v: string): string {
	return v
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// pt with one decimal, as P-touch writes them ("175.7pt", "8.4pt", "28pt").
export const pt = (n: number): string => `${Math.round(n * 10) / 10}pt`;
const mmToPt = (mm: number): number => mm / MM_PER_PT;

// QR version P-touch will pick for `bytes` bytes of data (auto version), from the capacity table.
export function qrVersion(bytes: number, level: 'M' | 'L'): number {
	const table = level === 'M' ? CAPACITY_M : CAPACITY_L;
	const i = table.findIndex((c) => c >= bytes);
	return i >= 0 ? i + 1 : table.length + Math.ceil((bytes - table[table.length - 1]) / 16);
}

// Modules per side of a QR of `bytes` bytes at `level`.
export const qrModuleCount = (bytes: number, level: 'M' | 'L'): number => 17 + 4 * qrVersion(bytes, level);

export interface LbxQr {
	level: 'M' | 'L';
	// pt per module
	cellPt: number;
	// the whole object (modules plus the quiet zone P-touch adds), pt
	sizePt: number;
}

// The level and the cell size that make the QR fit a square of `boxPt`: the 15% level with the biggest cell step
// that fits, if that cell is at least MIN_CELL_M_PT; else 7% with the biggest step that fits; else 7% at the
// smallest step (the code then overflows its box a little, and the page warns for dense labels).
export function chooseLbxQr(payload: string, boxPt: number): LbxQr {
	const bytes = new TextEncoder().encode(payload).length;
	const at = (level: 'M' | 'L', cellPt: number): LbxQr => ({ level, cellPt, sizePt: (qrModuleCount(bytes, level) + 2 * QUIET) * cellPt });
	for (const level of ['M', 'L'] as const) {
		for (const cellPt of CELL_STEPS_PT) {
			if (level === 'M' && cellPt < MIN_CELL_M_PT) continue;
			const q = at(level, cellPt);
			if (q.sizePt <= boxPt + 1e-6) return q;
		}
	}
	return at('L', CELL_STEPS_PT[CELL_STEPS_PT.length - 1]);
}

interface ObjectBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

const objectStyle = (b: ObjectBox, pen: 'INSIDEFRAME' | 'NULL', anchor: 'CENTER' | 'TOPLEFT'): string =>
	`<pt:objectStyle x="${pt(b.x)}" y="${pt(b.y)}" width="${pt(b.w)}" height="${pt(b.h)}" backColor="#FFFFFF" ropMode="COPYPEN" angle="0" anchor="${anchor}" flip="NONE">` +
	`<pt:pen style="${pen}" widthX="0.5pt" widthY="0.5pt" color="#000000"/><pt:brush style="NULL" color="#000000" id="0"/>` +
	'<pt:expanded objectName="" ID="0" lock="0" templateMergeTarget="LABELLIST" templateMergeType="NONE" templateMergeID="0" linkStatus="NONE" linkID="0"/>' +
	'</pt:objectStyle>';

function qrObject(payload: string, box: ObjectBox, qr: LbxQr): string {
	return (
		'<barcode:barcode>' +
		objectStyle(box, 'INSIDEFRAME', 'CENTER') +
		'<barcode:barcodeStyle protocol="QRCODE" lengths="48" barWidth="1.2pt" barRatio="1:3" humanReadable="false" humanReadableAlignment="LEFT" checkDigit="true" autoLengths="true" margin="true" sameLengthBar="false" bearerBar="false"/>' +
		`<barcode:qrcodeStyle model="2" eccLevel="${qr.level === 'M' ? '15%' : '7%'}" cellSize="${qr.cellPt.toFixed(1)}pt" mbcs="65001" joint="1" version="auto"/>` +
		// Line breaks as P-touch itself writes them in text data: CRLF.
		`<pt:data>${xmlText(payload).replace(/\n/g, '\r\n')}</pt:data>` +
		'</barcode:barcode>'
	);
}

function fontInfo(sizePt: number, bold: boolean): string {
	return (
		`<text:ptFontInfo><text:logFont name="${FONT}" width="0" italic="false" weight="${bold ? 700 : 400}" charSet="0" pitchAndFamily="34"/>` +
		`<text:fontExt effect="NOEFFECT" underline="0" strikeout="0" size="${pt(sizePt)}" orgSize="${ORG_SIZE_PT}pt" textColor="#000000"/></text:ptFontInfo>`
	);
}

// One line of text in a frame that shrinks the text to fit (so a long code is never cut off).
function textObject(text: string, box: ObjectBox, sizePt: number, bold: boolean, align: 'left' | 'center'): string {
	const font = fontInfo(sizePt, bold);
	return (
		'<text:text>' +
		objectStyle(box, 'NULL', 'TOPLEFT') +
		font +
		'<text:textControl control="FIXEDFRAME" clipFrame="false" aspectNormal="true" shrink="true" autoLF="false" avoidImage="false"/>' +
		`<text:textAlign horizontalAlignment="${align === 'center' ? 'CENTER' : 'LEFT'}" verticalAlignment="TOP" inLineAlignment="BASELINE"/>` +
		`<text:textStyle vertical="false" nullBlock="false" charSpace="0" lineSpace="0" orgPoint="${pt(sizePt)}" combinedChars="false"/>` +
		`<pt:data>${xmlText(text)}</pt:data>` +
		`<text:stringItem charLen="${text.length}">${font}</text:stringItem>` +
		'</text:text>'
	);
}

// The label's length along the feed in pt: the template's label height.
export function lbxLengthPt(t: LabelTemplate): number {
	return Math.round(mmToPt(t.labelHeightMm) * 10) / 10;
}

// label.xml for one sample. `contactEmail` is the lab contact of the QR payload (null or '' for none).
export function buildLbxLabelXml(s: LabelSample, t: LabelTemplate, contactEmail: string | null): string {
	const length = lbxLengthPt(t);
	const usableW = PAPER_WIDTH_PT - MARGIN_ACROSS_L - MARGIN_ACROSS_R;
	const usableH = Math.max(1, length - 2 * MARGIN_ALONG);
	// The layout engine places everything inside the printable area, so no object reaches P-touch's unprintable margin.
	const area: LabelTemplate = { ...t, labelWidthMm: usableW * MM_PER_PT, labelHeightMm: usableH * MM_PER_PT };
	const layout = layoutLabel(s, area);
	const at = (b: { x: number; y: number; w: number; h: number }): ObjectBox => ({
		x: MARGIN_ACROSS_L + mmToPt(b.x),
		y: MARGIN_ALONG + mmToPt(b.y),
		w: mmToPt(b.w),
		h: mmToPt(b.h),
	});

	const objects: string[] = [];
	if (layout.qr) {
		const payload = buildQrPayload(s, contactEmail, t.qrFields);
		const box = at(layout.qr);
		const qr = chooseLbxQr(payload, Math.min(box.w, box.h));
		// The object is the code and its quiet zone, centred in the box the layout gave it.
		const side = qr.sizePt;
		objects.push(qrObject(payload, { x: box.x + (box.w - side) / 2, y: box.y + (box.h - side) / 2, w: side, h: side }, qr));
	}
	for (const line of layout.lines) objects.push(textObject(line.text, at(line), line.pt, line.bold, line.align));

	const paper =
		`<style:paper media="0" width="${PAPER_WIDTH_PT}pt" height="${pt(length)}" marginLeft="${MARGIN_ACROSS_L}pt" marginTop="${MARGIN_ALONG}pt" marginRight="${MARGIN_ACROSS_R}pt" marginBottom="${MARGIN_ALONG}pt" ` +
		`orientation="portrait" autoLength="false" monochromeDisplay="true" paperColor="#FFFFFF" paperInk="#000000" split="1" format="${FORMAT_62_CONTINUOUS}" backgroundTheme="0" printerID="${PRINTER_ID}" printerName="${PRINTER_NAME}"/>`;
	const back = `<style:backGround x="${MARGIN_ACROSS_L}pt" y="${MARGIN_ALONG}pt" width="${pt(usableW)}" height="${pt(usableH)}" brushStyle="NULL" brushId="0" color="#000000" backColor="#FFFFFF"/>`;

	return (
		DECLARATION +
		`<pt:document ${NS} version="1.0"><pt:body currentSheet="Sheet 1"><style:sheet name="Sheet 1">` +
		paper +
		'<style:cutLine regularCut="0pt" freeCut=""/>' +
		back +
		`<pt:objects>${objects.join('')}</pt:objects>` +
		'</style:sheet></pt:body></pt:document>'
	);
}

// prop.xml: the document properties. `title` is the label's name in P-touch Editor's title bar.
export function buildPropXml(title = 'D1 sample label', now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
	return (
		DECLARATION +
		'<meta:properties xmlns:meta="http://schemas.brother.info/ptouch/2007/lbx/meta" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">' +
		`<meta:appName>P-touch Editor</meta:appName><dc:title>${xmlText(title)}</dc:title><dc:subject></dc:subject><dc:creator>D1-Database</dc:creator>` +
		'<meta:keyword></meta:keyword><dc:description></dc:description><meta:template></meta:template>' +
		`<dcterms:created>${stamp}</dcterms:created><dcterms:modified>${stamp}</dcterms:modified><meta:lastPrinted></meta:lastPrinted>` +
		'<meta:modifiedBy>D1-Database</meta:modifiedBy><meta:revision>1</meta:revision><meta:editTime>0</meta:editTime><meta:numPages>1</meta:numPages>' +
		'<meta:numWords>0</meta:numWords><meta:numChars>0</meta:numChars><meta:security>0</meta:security></meta:properties>'
	);
}
