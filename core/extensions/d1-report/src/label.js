// Sample labels for the d1-report endpoint: request validation, sheet layout maths and
// the print-ready HTML. Pure functions only (no Directus, no database), so they are unit
// tested in label.test.mjs. The endpoint wiring, the permission-aware reads and the QR
// generation live in index.js.
//
// Two layouts:
//   a4-21          an A4 sheet of 21 labels, 63.5 x 38.1 mm, 3 columns x 7 rows (the common
//                  "L7160" size: Avery L7160, Herma 4630, ...)
//   single-50x25   one 50 x 25 mm label per page, for a roll / label-printer
//
// The page is our own HTML with @page rules, printed with the browser's "Save as PDF" /
// Print, like the other d1-report documents. Each label sits at an absolute mm position, so
// what the browser prints lines up with the die-cut sheet when printed at 100% scale.

import { adminRecordUrl, esc } from './render.js';

export const MAX_LABELS = 200;
export const DEFAULT_LAYOUT = 'a4-21';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sample codes look like 10-AA-MF-2023-06-03; accept letters, digits and . _ - / only.
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

// A short, harmless hint of a rejected token for an error message: only characters a valid
// id / code could hold survive, everything else (markup, quotes) becomes '?'.
const hint = (t) => t.slice(0, 40).replace(/[^A-Za-z0-9._/-]/g, '?');

const round2 = (n) => Math.round(n * 100) / 100;

// ---- layouts --------------------------------------------------------------------------

function sheetLayout(def) {
	const { pageW, pageH, cols, rows, labelW, labelH, gapX = 0, gapY = 0 } = def;
	// Centre the grid on the page (what a standard die-cut sheet does).
	const marginLeft = round2((pageW - (cols * labelW + (cols - 1) * gapX)) / 2);
	const marginTop = round2((pageH - (rows * labelH + (rows - 1) * gapY)) / 2);
	return {
		...def,
		gapX,
		gapY,
		marginLeft,
		marginTop,
		pitchX: round2(labelW + gapX),
		pitchY: round2(labelH + gapY),
		perPage: cols * rows,
	};
}

export const LAYOUTS = {
	'a4-21': sheetLayout({
		title: 'A4 sheet, 21 labels (63.5 x 38.1 mm)',
		pageW: 210,
		pageH: 297,
		cols: 3,
		rows: 7,
		labelW: 63.5,
		labelH: 38.1,
		gapX: 2.54,
		gapY: 0,
		style: { padMm: 2.5, qrMm: 23, codeMaxPt: 18, metaPt: 8, qrEcc: 'M' },
	}),
	'single-50x25': sheetLayout({
		title: 'Single label, 50 x 25 mm',
		pageW: 50,
		pageH: 25,
		cols: 1,
		rows: 1,
		labelW: 50,
		labelH: 25,
		style: { padMm: 1.5, qrMm: 15.5, codeMaxPt: 14, metaPt: 6, qrEcc: 'L' },
	}),
};

export function resolveLayout(name) {
	const key = name === undefined || name === null || name === '' ? DEFAULT_LAYOUT : String(name);
	// own-property check: 'constructor' / '__proto__' must not resolve
	return Object.prototype.hasOwnProperty.call(LAYOUTS, key) ? { key, layout: LAYOUTS[key] } : null;
}

// Top-left corner (mm) of the label in 0-based `slot` of a page, row by row.
export function slotPosition(layout, slot) {
	const col = slot % layout.cols;
	const row = Math.floor(slot / layout.cols);
	return { x: round2(layout.marginLeft + col * layout.pitchX), y: round2(layout.marginTop + row * layout.pitchY) };
}

// `start` = the 1-based position on the first sheet of the first label to print, so a
// part-used sheet can be reused. Returns { skip } (positions to leave empty). Single-label
// layouts have nothing to skip, so any start is accepted and ignored there.
export function parseStart(raw, layout) {
	if (raw === undefined || raw === null || raw === '') return { skip: 0 };
	const s = String(raw).trim();
	if (!/^\d{1,4}$/.test(s)) return { error: 'start must be a whole number' };
	if (layout.perPage === 1) return { skip: 0 };
	const n = Number(s);
	if (n < 1 || n > layout.perPage) return { error: `start must be between 1 and ${layout.perPage} for this layout` };
	return { skip: n - 1 };
}

// Split `count` labels over pages, leaving the first `skip` slots of page 1 empty.
// Returns pages of { slot, index, x, y } (index = position in the labels array).
export function paginate(count, layout, skip = 0) {
	const pages = [];
	for (let i = 0; i < count; i++) {
		const pos = i + skip;
		const page = Math.floor(pos / layout.perPage);
		const slot = pos % layout.perPage;
		(pages[page] ||= []).push({ slot, index: i, ...slotPosition(layout, slot) });
	}
	return pages;
}

// Font size (pt) for the sample code so the whole code fits `widthMm` on one line, capped at
// `maxPt` and floored so a long code stays legible. Bold sans-serif is ~0.62 em per glyph.
export function codeFontPt(code, widthMm, maxPt, minPt = 7) {
	const len = Math.max(1, String(code ?? '').length);
	const pt = widthMm / (len * 0.62) / 0.3528;
	return round2(Math.max(minPt, Math.min(maxPt, pt)));
}

// ---- scan-to-open ---------------------------------------------------------------------

// What a label's QR code encodes: the sample's record in the Directus app. That page is
// behind sign-in (the app sends a signed-out phone to its login page and back to the
// record afterwards), is responsive on a phone, and shows only what the signed-in user's
// permissions allow. No data is encoded in the QR beyond the id, and no public route exists.
export function sampleRecordUrl(publicUrl, sampleId) {
	return adminRecordUrl(publicUrl, 'physical_samples', sampleId);
}

// ---- request validation ---------------------------------------------------------------

// Query values may be a string ("a,b c"), repeated params (['a', 'b']) or absent.
function tokens(raw) {
	const parts = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const out = [];
	for (const p of parts) {
		if (typeof p !== 'string') return null; // ?ids[x]=1 style objects: reject
		for (const t of p.split(/[\s,;]+/)) if (t) out.push(t);
	}
	return out;
}

// Validate and de-duplicate the requested samples: `ids` are sample UUIDs, `codes` human
// sample codes. At least one is required; ids and codes are each capped at MAX_LABELS.
export function parseSelection(query = {}) {
	const idTokens = tokens(query.ids);
	const codeTokens = tokens(query.codes);
	if (idTokens === null || codeTokens === null) return { error: 'ids and codes must be lists of text values' };
	if (!idTokens.length && !codeTokens.length) return { error: 'Pass ids=<uuid,uuid,...> (or codes=<sample code,...>).' };
	if (idTokens.length + codeTokens.length > MAX_LABELS * 4) return { error: `At most ${MAX_LABELS} samples per sheet.` };

	const bad = idTokens.find((t) => !UUID_RE.test(t));
	if (bad !== undefined) return { error: `Not a valid sample id: ${hint(bad)}` };
	const badCode = codeTokens.find((t) => !CODE_RE.test(t));
	if (badCode !== undefined) return { error: `Not a valid sample code: ${hint(badCode)}` };

	const ids = [...new Set(idTokens.map((t) => t.toLowerCase()))];
	const codes = [...new Set(codeTokens)];
	// Each list is capped here; a code may name a sample that is also in `ids`, so the cap on
	// distinct samples is applied after the codes are resolved (the endpoint, via capError).
	if (ids.length > MAX_LABELS || codes.length > MAX_LABELS) return { error: `At most ${MAX_LABELS} samples per sheet.` };
	return { ids, codes };
}

// The message for a selection that resolved to more than MAX_LABELS distinct samples, or ''.
export const capError = (rows) => (rows.length > MAX_LABELS ? `At most ${MAX_LABELS} samples per sheet.` : '');

// Put the readable `rows` back in the order they were requested (ids first, then codes),
// one label per sample even if it was named by both id and code.
export function orderRows(rows, { ids, codes }) {
	const byId = new Map(rows.map((r) => [String(r.sample_id).toLowerCase(), r]));
	const byCode = new Map(rows.map((r) => [String(r.sample_code), r]));
	const out = [];
	const seen = new Set();
	const push = (r) => {
		if (!r || seen.has(r.sample_id)) return;
		seen.add(r.sample_id);
		out.push(r);
	};
	ids.forEach((id) => push(byId.get(id)));
	codes.forEach((c) => push(byCode.get(c)));
	return out;
}

// "Ada Lovelace" -> "AL"; "ada" -> "A"; empty / unreadable -> ''.
export function initials(fullName) {
	const words = String(fullName ?? '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (!words.length) return '';
	const letters = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
	return letters.map((w) => Array.from(w)[0].toUpperCase()).join('');
}

export const DEFAULT_TIMEZONE = 'Europe/London';

// The IANA zone label dates are read in: env D1_TIMEZONE, else Europe/London. The Directus
// container runs in UTC (no TZ set), so a sample entered at 00:30 BST would otherwise be labelled
// with the previous day. An unknown zone name falls back to the default rather than failing the print.
function labelTimeZone() {
	const tz = (process.env.D1_TIMEZONE || '').trim() || DEFAULT_TIMEZONE;
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: tz });
		return tz;
	} catch {
		return DEFAULT_TIMEZONE;
	}
}

// ISO date (YYYY-MM-DD) for a DATE string or a timestamp; '' when absent / invalid. A DATE
// string is used as is; a timestamp is read in the D1_TIMEZONE zone (default Europe/London), so
// a sample created just after local midnight shows that day, not the previous UTC day.
export function labelDate(manufactured, created) {
	const v = manufactured || created;
	if (!v) return '';
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
	const d = new Date(v);
	if (isNaN(d)) return '';
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: labelTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(d);
	const get = (type) => parts.find((x) => x.type === type)?.value;
	return `${get('year')}-${get('month')}-${get('day')}`;
}

// ---- HTML -----------------------------------------------------------------------------

const BASE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#e5e7eb;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111}
.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #cbd5e1;font-size:14px}
.toolbar form{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0}
.toolbar input[type=number]{width:4.5em}
.toolbar button,.toolbar a.btn{padding:6px 14px;border:1px solid #1d4ed8;border-radius:6px;background:#1d4ed8;color:#fff;font:inherit;text-decoration:none;cursor:pointer}
.toolbar button.secondary{background:#fff;color:#1d4ed8}
.toolbar .note{color:#92400e}
.sheet{position:relative;background:#fff;margin:16px auto;box-shadow:0 1px 6px rgba(0,0,0,.25);overflow:hidden}
.label{position:absolute;overflow:hidden;color:#000}
@media screen{.label{outline:.2mm dashed #cbd5e1;outline-offset:-.2mm}}
.label .code{font-weight:700;line-height:1.05;white-space:nowrap;font-family:ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;letter-spacing:-.02em}
.label .row{display:flex;gap:1.5mm;align-items:flex-start}
.label .qr{flex:none;background:#fff}
.label .qr svg{display:block;width:100%;height:100%}
.label .meta{flex:1;min-width:0;line-height:1.2}
.label .meta div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.label .meta .mat{font-weight:600;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.label .meta .k{color:#444}
.picker{max-width:880px;margin:20px auto;padding:0 16px 40px}
.picker h1{font-size:22px;margin:0 0 4px}
.picker .card{background:#fff;border:1px solid #cbd5e1;border-radius:8px;padding:14px 16px;margin:12px 0}
.picker textarea{width:100%;min-height:5em;font:13px ui-monospace,Menlo,Consolas,monospace}
.picker table{width:100%;border-collapse:collapse;font-size:14px}
.picker th,.picker td{text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb}
.picker .muted{color:#555;font-size:13px}
.picker button{padding:7px 16px;border:1px solid #1d4ed8;border-radius:6px;background:#1d4ed8;color:#fff;font:inherit;cursor:pointer}
.picker button.secondary{background:#fff;color:#1d4ed8}
`;

function labelHtml(l, layout, pos) {
	const s = layout.style;
	const innerW = round2(layout.labelW - 2 * s.padMm);
	const pt = codeFontPt(l.code, innerW, s.codeMaxPt);
	const meta = [
		l.material ? `<div class="mat">${esc(l.material)}</div>` : '',
		l.date ? `<div><span class="k">Date</span> ${esc(l.date)}</div>` : '',
		l.owner ? `<div><span class="k">Owner</span> ${esc(l.owner)}</div>` : '',
	].join('');
	return `<div class="label" style="left:${pos.x}mm;top:${pos.y}mm;width:${layout.labelW}mm;height:${layout.labelH}mm;padding:${s.padMm}mm">
<div class="code" style="font-size:${pt}pt;margin-bottom:1.2mm">${esc(l.code)}</div>
<div class="row"><div class="qr" style="width:${s.qrMm}mm;height:${s.qrMm}mm">${l.qrSvg}</div><div class="meta" style="font-size:${s.metaPt}pt">${meta}</div></div>
</div>`;
}

// labels: [{ code, material, date, owner, qrSvg }]  (qrSvg is trusted markup from `qrcode`)
export function renderLabelSheet({ labels, layoutKey, skip = 0, query = {}, notice = '' }) {
	const layout = LAYOUTS[layoutKey];
	const pages = paginate(labels.length, layout, skip);
	const sheets = pages
		.map(
			(slots, i) =>
				`<div class="sheet" style="width:${layout.pageW}mm;height:${layout.pageH}mm${i < pages.length - 1 ? ';break-after:page' : ''}">${slots
					.map((p) => labelHtml(labels[p.index], layout, p))
					.join('\n')}</div>`
		)
		.join('\n');

	const hidden = ['ids', 'codes']
		.filter((k) => query[k] !== undefined)
		.flatMap((k) => (Array.isArray(query[k]) ? query[k] : [query[k]]).map((v) => ({ k, v })))
		.map(({ k, v }) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
		.join('');
	const options = Object.entries(LAYOUTS)
		.map(([k, l]) => `<option value="${esc(k)}"${k === layoutKey ? ' selected' : ''}>${esc(l.title)}</option>`)
		.join('');
	const skipField =
		layout.perPage > 1
			? `<label>Start at position <input type="number" name="start" min="1" max="${layout.perPage}" value="${skip + 1}"></label>`
			: '';

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sample labels (${labels.length})</title>
<style>${BASE_CSS}
@page{size:${layout.pageW}mm ${layout.pageH}mm;margin:0}
@media print{body{background:#fff}.toolbar{display:none}.sheet{margin:0;box-shadow:none}}
</style></head><body>
<div class="toolbar">
<button type="button" id="printBtn">Print labels</button>
<form method="get" action="label" id="layoutForm">${hidden}
<label>Layout <select name="layout">${options}</select></label>${skipField}
<button type="submit" class="secondary">Update</button></form>
<a href="labels">Pick other samples</a>
<span>${labels.length} label${labels.length === 1 ? '' : 's'}, ${pages.length} page${pages.length === 1 ? '' : 's'}. Print at 100% scale (no "fit to page").</span>
${notice ? `<span class="note">${esc(notice)}</span>` : ''}
</div>
${sheets}
<script src="label.js"></script>
</body></html>`;
}

// The page behind "Print labels": paste sample codes and/or tick recent samples.
// rows: [{ sample_id, sample_code }]; q = the current search text.
export function renderLabelPicker({ rows, q = '', total = 0 }) {
	const options = Object.entries(LAYOUTS)
		.map(([k, l]) => `<option value="${esc(k)}">${esc(l.title)}</option>`)
		.join('');
	const list = rows.length
		? `<table><thead><tr><th><input type="checkbox" id="selAll" aria-label="Select all"></th><th>Sample</th></tr></thead><tbody>${rows
				.map(
					(r) =>
						`<tr><td><input type="checkbox" name="ids" value="${esc(r.sample_id)}" form="printForm" aria-label="${esc(r.sample_code)}"></td><td>${esc(r.sample_code)}</td></tr>`
				)
				.join('')}</tbody></table>`
		: '<p class="muted">No samples found.</p>';
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Print sample labels</title><style>${BASE_CSS}</style></head><body>
<div class="picker">
<h1>Print sample labels</h1>
<p class="muted">Each label has the sample code, a QR code that opens the record (sign-in required), the material, the date and the owner's initials. Up to ${MAX_LABELS} samples at a time.</p>
<form method="get" action="label" id="printForm" target="_blank">
<div class="card"><b>1. Choose samples</b>
<p class="muted">Paste sample codes (separated by commas, spaces or new lines), and/or tick samples in the list below.</p>
<textarea name="codes" placeholder="e.g. 10-AA-MF-2023-06-03"></textarea></div>
<div class="card"><b>2. Layout</b>
<p><select name="layout">${options}</select>
 <label>Start at position <input type="number" name="start" min="1" max="21" value="1" style="width:4.5em"></label></p>
<p class="muted">"Start at position" skips labels already used on a part-used sheet (A4 layout only).</p>
<button type="submit">Open label sheet</button></div>
</form>
<div class="card"><b>Samples</b> <span class="muted">(${rows.length}${total > rows.length ? ` of ${total}` : ''}, newest first)</span>
<form method="get" action="labels" style="margin:8px 0"><input type="search" name="q" value="${esc(q)}" placeholder="Search by code" aria-label="Search by code">
 <button type="submit" class="secondary">Search</button></form>
${list}</div>
</div>
<script src="label.js"></script>
</body></html>`;
}

// Same-origin script (Directus's CSP blocks inline scripts): the Print button and the
// picker's "select all" box.
export const LABEL_JS = `(function () {
	var pb = document.getElementById('printBtn');
	if (pb) pb.addEventListener('click', function () { window.print(); });
	var all = document.getElementById('selAll');
	if (all) all.addEventListener('change', function () {
		document.querySelectorAll('input[name="ids"]').forEach(function (cb) { cb.checked = all.checked; });
	});
})();`;
