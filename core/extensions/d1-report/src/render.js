// Renders the Sample Overview as a self-contained, print-ready HTML page (A4).
// The sample's life is a vertical timeline — origin → created → manufacturing →
// testing → children — and operation/test rows are colour-coded by campaign (a
// filled dot) and project (a hollow ring). No external assets: the QR is inline
// SVG, all styling is inline, and a no-print toolbar lets the user toggle blocks
// (the document reflows). URL params like ?operations=0 set the initial state.

import { buildGeometry } from './geometry';

const esc = (v) =>
	v === null || v === undefined
		? ''
		: String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const dash = (v) => (v === null || v === undefined || v === '' ? '—' : esc(v));

function fmtDate(v) {
	if (!v) return '—';
	const d = new Date(v);
	if (isNaN(d)) return esc(v);
	return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function fmtDateTime(v) {
	if (!v) return '—';
	const d = new Date(v);
	if (isNaN(d)) return esc(v);
	return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function num(v, digits = 3) {
	if (v === null || v === undefined || v === '') return '—';
	const n = Number(v);
	return isNaN(n) ? esc(v) : n.toLocaleString('en-GB', { maximumFractionDigits: digits });
}

function niceNum(v) {
	const a = Math.abs(v);
	if (a === 0) return '0';
	if (a >= 1000) return `${(v / 1000).toFixed(1)}k`;
	if (a >= 100) return v.toFixed(0);
	if (a >= 10) return v.toFixed(1);
	if (a >= 1) return v.toFixed(2);
	if (a >= 0.01) return v.toFixed(3);
	return v.toExponential(0);
}

// A "nice" step (1/2/5 * 10^n) so evenly-spaced ticks land on round numbers.
function niceStep(rough) {
	if (!(rough > 0)) return 1;
	const pow = 10 ** Math.floor(Math.log10(rough));
	const f = rough / pow;
	const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
	return nice * pow;
}

function regularTicks(x0, x1, plotW, targetPx = 55) {
	const targetCount = Math.max(3, Math.min(8, Math.round(plotW / targetPx)));
	const step = niceStep((x1 - x0) / targetCount) || x1 - x0 || 1;
	const ticks = [];
	const first = Math.ceil(x0 / step) * step;
	for (let v = first; v <= x1 + step * 1e-6; v += step) {
		if (v < x0 - step * 1e-6) continue;
		ticks.push(v);
	}
	if (ticks.length < 2) return [x0, x1];
	return ticks;
}

// Static (non-interactive) SVG force/RPM envelope, for the print report. Mirrors
// d1-force-dashboard/src/ForceChart.vue's math (env kind + crop-window shading,
// regular x-ticks) at a fixed small size — no ResizeObserver/hover needed since
// this is print-only.
function miniEnvelopeSvg(series, { color = '#1d4ed8', width = 300, height = 118, xUnit = 's', yUnit = 'N', cropStart, cropEnd } = {}) {
	if (!series?.t?.length) return '<div class="fc-empty">no data</div>';
	const ML = 32, MR = 6, MT = 14, MB = 20;
	const t = series.t, mn = series.min, mx = series.max;
	const x0 = t[0], x1 = t[t.length - 1];
	let lo = Math.min(0, ...mn), hi = Math.max(0, ...mx);
	if (hi === lo) hi = lo + 1;
	const plotW = width - ML - MR, plotH = height - MT - MB;
	const sx = (x) => ML + ((x - x0) / (x1 - x0 || 1)) * plotW;
	const sy = (y) => MT + (1 - (y - lo) / (hi - lo)) * plotH;

	function areaPath(i0, i1) {
		let up = 'M';
		for (let i = i0; i <= i1; i++) up += `${sx(t[i]).toFixed(1)},${sy(mx[i]).toFixed(1)} `;
		let dn = '';
		for (let i = i1; i >= i0; i--) dn += `${sx(t[i]).toFixed(1)},${sy(mn[i]).toFixed(1)} `;
		return `${up}L ${dn}Z`;
	}
	const fullArea = areaPath(0, t.length - 1);
	let cropArea = '';
	if (cropStart != null && cropEnd != null) {
		let i0 = t.findIndex((v) => v >= cropStart);
		let i1 = t.length - 1 - [...t].reverse().findIndex((v) => v <= cropEnd);
		if (i0 < 0) i0 = 0;
		if (i1 < i0) i1 = t.length - 1;
		if (i1 > i0) cropArea = areaPath(i0, i1);
	}
	const zeroY = lo < 0 && hi > 0 ? sy(0) : null;
	const yVals = zeroY != null ? [hi, (hi + 0) / 2, 0, lo / 2, lo] : [hi, (hi + lo) / 2, lo];
	const yticks = [...new Set(yVals.map((v) => Math.round(v * 1000) / 1000))]
		.map((v) => ({ y: sy(v), label: niceNum(v) }));
	const xticks = regularTicks(x0, x1, plotW).map((v) => ({ x: sx(v), label: niceNum(v) }));

	return `<svg viewBox="0 0 ${width} ${height}">
		<text x="${ML}" y="9" class="axislabel">${esc(yUnit)}</text>
		${yticks.map((tk) => `<line x1="${ML}" x2="${width - MR}" y1="${tk.y.toFixed(1)}" y2="${tk.y.toFixed(1)}" stroke="#eef1f5" stroke-width="0.4"/>`).join('')}
		<line x1="${ML}" x2="${width - MR}" y1="${height - MB}" y2="${height - MB}" stroke="#94a3b8" stroke-width="0.6"/>
		<line x1="${ML}" x2="${ML}" y1="${MT}" y2="${height - MB}" stroke="#94a3b8" stroke-width="0.6"/>
		${zeroY != null ? `<line x1="${ML}" x2="${width - MR}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="#cbd5e1" stroke-width="0.5"/>` : ''}
		<path d="${fullArea}" fill="${color}" fill-opacity="${cropArea ? 0.1 : 0.22}" stroke="${color}" stroke-opacity="0.4" stroke-width="0.4"/>
		${cropArea ? `<path d="${cropArea}" fill="${color}" fill-opacity="0.3" stroke="${color}" stroke-width="0.5"/>` : ''}
		${yticks.map((tk) => `<line x1="${ML - 2.5}" x2="${ML}" y1="${tk.y.toFixed(1)}" y2="${tk.y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.6"/><text x="${ML - 4}" y="${(tk.y + 2.2).toFixed(1)}" text-anchor="end" class="tick">${tk.label}</text>`).join('')}
		${xticks.map((tk) => `<line x1="${tk.x.toFixed(1)}" x2="${tk.x.toFixed(1)}" y1="${height - MB}" y2="${height - MB + 2.5}" stroke="#94a3b8" stroke-width="0.6"/><text x="${tk.x.toFixed(1)}" y="${height - MB + 9}" text-anchor="middle" class="tick">${tk.label}</text>`).join('')}
		<text x="${((ML + width - MR) / 2).toFixed(1)}" y="${height - 2}" text-anchor="middle" class="axislabel">${esc(xUnit)}</text>
	</svg>`;
}

// Static log-scale FFT amplitude spectrum SVG (decade y-ticks + regular x-ticks).
function miniFftSvg(spec, { color = '#1d4ed8', width = 300, height = 118 } = {}) {
	if (!spec?.f?.length) return '<div class="fc-empty">no data</div>';
	const ML = 32, MR = 6, MT = 14, MB = 20;
	const f = spec.f, amp = spec.amp;
	const x0 = f[0], x1 = f[f.length - 1];
	const hi = Math.max(...amp, 1e-9);
	let minPos = Infinity;
	for (const v of amp) if (v > 0 && v < minPos) minPos = v;
	if (!isFinite(minPos)) minPos = hi / 1e5;
	const loRaw = Math.max(minPos, hi / 1e5);
	const L0 = Math.log10(loRaw), L1 = Math.log10(hi), den = L1 - L0 || 1;
	const plotW = width - ML - MR, plotH = height - MT - MB;
	const sx = (x) => ML + ((x - x0) / (x1 - x0 || 1)) * plotW;
	const sy = (y) => MT + (1 - (Math.log10(Math.max(y, loRaw)) - L0) / den) * plotH;
	let line = 'M';
	for (let i = 0; i < f.length; i++) line += `${sx(f[i]).toFixed(1)},${sy(amp[i]).toFixed(1)} `;

	let yticks = [];
	for (let k = Math.ceil(L0); k <= Math.floor(L1); k++) yticks.push({ y: sy(10 ** k), label: niceNum(10 ** k) });
	if (yticks.length < 2) yticks = [loRaw, hi].map((v) => ({ y: sy(v), label: niceNum(v) }));
	const xticks = regularTicks(x0, x1, plotW).map((v) => ({ x: sx(v), label: niceNum(v) }));

	return `<svg viewBox="0 0 ${width} ${height}">
		<text x="${ML}" y="9" class="axislabel">log amp</text>
		${yticks.map((tk) => `<line x1="${ML}" x2="${width - MR}" y1="${tk.y.toFixed(1)}" y2="${tk.y.toFixed(1)}" stroke="#eef1f5" stroke-width="0.4"/>`).join('')}
		<line x1="${ML}" x2="${width - MR}" y1="${height - MB}" y2="${height - MB}" stroke="#94a3b8" stroke-width="0.6"/>
		<line x1="${ML}" x2="${ML}" y1="${MT}" y2="${height - MB}" stroke="#94a3b8" stroke-width="0.6"/>
		<path d="${line}" fill="none" stroke="${color}" stroke-width="0.6"/>
		${yticks.map((tk) => `<line x1="${ML - 2.5}" x2="${ML}" y1="${tk.y.toFixed(1)}" y2="${tk.y.toFixed(1)}" stroke="#94a3b8" stroke-width="0.6"/><text x="${ML - 4}" y="${(tk.y + 2.2).toFixed(1)}" text-anchor="end" class="tick">${tk.label}</text>`).join('')}
		${xticks.map((tk) => `<line x1="${tk.x.toFixed(1)}" x2="${tk.x.toFixed(1)}" y1="${height - MB}" y2="${height - MB + 2.5}" stroke="#94a3b8" stroke-width="0.6"/><text x="${tk.x.toFixed(1)}" y="${height - MB + 9}" text-anchor="middle" class="tick">${tk.label}</text>`).join('')}
		<text x="${((ML + width - MR) / 2).toFixed(1)}" y="${height - 2}" text-anchor="middle" class="axislabel">f (Hz)</text>
	</svg>`;
}

function dateRange(rows, key) {
	const ds = rows.map((r) => r[key]).filter(Boolean).map((v) => new Date(v)).filter((d) => !isNaN(d));
	if (!ds.length) return '';
	const min = new Date(Math.min(...ds));
	const max = new Date(Math.max(...ds));
	return min.getTime() === max.getTime() ? fmtDate(min) : `${fmtDate(min)} – ${fmtDate(max)}`;
}

const PALETTE = ['#2563eb', '#0d9488', '#d97706', '#7c3aed', '#dc2626', '#0891b2', '#65a30d', '#db2777'];

export function renderSampleReport(d) {
	const { sample: s, owner, nickname, location, surfaceFinish, ops, parents, children, tests, qrSvg, recordUrl } = d;

	const ownerName = owner ? (owner.full_name || [owner.first_name, owner.last_name].filter(Boolean).join(' ')) : '';
	const shortId = String(s.sample_id).split('-')[0];
	const dims = [
		s.diameter_mm ? `Ø${num(s.diameter_mm, 2)}` : null,
		s.length_mm ? `L${num(s.length_mm, 2)}` : null,
		s.thickness_mm ? `t${num(s.thickness_mm, 2)}` : null,
	].filter(Boolean).join(' × ');

	// ---- campaign / project colour maps (assigned in order of appearance) ----
	const campaignInfo = {};
	const projectInfo = {};
	[...ops, ...tests].forEach((r) => {
		if (r.campaign_code && !(r.campaign_code in campaignInfo))
			campaignInfo[r.campaign_code] = { name: r.campaign_name || r.campaign_code, color: PALETTE[Object.keys(campaignInfo).length % PALETTE.length] };
		if (r.project_code && !(r.project_code in projectInfo))
			projectInfo[r.project_code] = { name: r.project_name || r.project_code, color: PALETTE[(Object.keys(projectInfo).length + 4) % PALETTE.length] };
	});
	const dotsFor = (r) => {
		const c = r.campaign_code && campaignInfo[r.campaign_code];
		const p = r.project_code && projectInfo[r.project_code];
		return `<span class="dots">${c ? `<span class="cdot" style="background:${c.color}" title="${esc(c.name)}"></span>` : ''}${
			p ? `<span class="pdot" style="border-color:${p.color}" title="${esc(projectInfo[r.project_code].name)}"></span>` : ''
		}</span>`;
	};
	const hasColourCoding = Object.keys(campaignInfo).length || Object.keys(projectInfo).length;
	const legend = hasColourCoding
		? `<div class="legend">
			${Object.keys(campaignInfo).length ? `<div class="lg-grp"><span class="lg-label">Campaign</span>${Object.values(campaignInfo)
				.map((c) => `<span class="lg-item"><span class="cdot" style="background:${c.color}"></span>${esc(c.name)}</span>`)
				.join('')}</div>` : ''}
			${Object.keys(projectInfo).length ? `<div class="lg-grp"><span class="lg-label">Project</span>${Object.entries(projectInfo)
				.map(([code, p]) => `<span class="lg-item"><span class="pdot" style="border-color:${p.color}"></span>${esc(code)}</span>`)
				.join('')}</div>` : ''}
		</div>`
		: '';

	// ---- header details grid ----
	const kv = (label, value, sub) =>
		`<div class="kv"><span class="k">${esc(label)}</span><span class="v">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
	const details = [
		kv('Owner', dash(ownerName || null), owner?.email ? esc(owner.email) : ''),
		kv('Status', dash(s.current_status)),
		kv('Manufactured', fmtDate(s.manufactured_date)),
		kv('Entry created', fmtDate(s.created_at)),
		kv('Location', dash(location)),
		kv('Surface finish', dash(surfaceFinish)),
		kv('Form', dash(s.form)),
		kv('Mass', s.mass_grams ? `${num(s.mass_grams, 2)} g` : '—'),
		kv('Dimensions', dims ? `${dims} <span class="unit">mm</span>` : '—'),
		kv('Density', s.density_g_per_cm3 ? `${num(s.density_g_per_cm3, 2)} <span class="unit">g/cm³</span>` : '—'),
		kv('Material', dash(s.material_name), [s.alloy_code, s.material_iso_code].filter(Boolean).map(esc).join(' · ')),
		kv('Project', dash(s.project_code), s.project_name ? esc(s.project_name) : ''),
	].join('');

	// ---- timeline items ----
	const items = [];

	if (parents.length) {
		items.push(tlItem({
			when: fmtDate(s.manufactured_date),
			title: 'Origin',
			body: `<div class="chips">${parents
				.map((p) => `<span class="chip"><span class="rel">${esc(p.relationship_type || 'from')}</span> <b>${esc(p.parent_sample_code)}</b>${
					p.fraction ? ` <span class="frac">${num(p.fraction * 100, 0)}%</span>` : ''
				}</span>`)
				.join('')}</div>`,
		}));
	}

	items.push(tlItem({
		when: fmtDate(s.manufactured_date),
		title: 'Sample created',
		current: true,
		body: `<div class="tl-note">${dash(s.material_name)}${s.manufacturing_route ? ` · ${esc(s.manufacturing_route)}` : ''}${
			nickname ? ` · <i>${esc(nickname)}</i>` : ''
		}</div>`,
	}));

	if (ops.length) {
		const rows = ops
			.map((o) => `<tr>
				<td class="dotcell">${dotsFor(o)}</td>
				<td class="mono">${dash(o.pass_code)}</td>
				<td>${[o.method_name, o.machining_operation_subtype].filter(Boolean).map(esc).join(' · ') || '—'}</td>
				<td class="n">${num(o.machining_cutting_speed_m_per_min, 1)}</td>
				<td class="n">${num(o.machining_feed_mm_per_rev, 3)}</td>
				<td class="n">${num(o.machining_spindle_speed_rpm, 0)}</td>
				<td class="n">${num(o.machining_axial_depth_of_cut_mm, 2)}</td>
				<td class="n">${fmtDate(o.operation_date)}</td>
			</tr>`)
			.join('');
		items.push(tlItem({
			id: 'operations',
			when: dateRange(ops, 'operation_date'),
			title: `Manufacturing <span class="count">${ops.length}</span>`,
			body: `${legend}<table class="tbl">
				<thead><tr><th></th><th>Op Code</th><th>Operation</th><th class="n">Vc</th><th class="n">Feed</th><th class="n">Spindle</th><th class="n">DoC</th><th class="n">Date</th></tr></thead>
				<tbody>${rows}</tbody></table>`,
		}));
	}

	if (tests.length) {
		const rows = tests
			.map((t) => `<tr>
				<td class="dotcell">${dotsFor(t)}</td>
				<td class="n">${fmtDate(t.session_date)}</td>
				<td>${dash(t.test_type)}</td>
				<td>${dash(t.operator_name)}</td>
				<td>${dash(t.status)}</td>
			</tr>`)
			.join('');
		items.push(tlItem({
			id: 'tests',
			when: dateRange(tests, 'session_date'),
			title: `Testing <span class="count">${tests.length}</span>`,
			body: `<table class="tbl">
				<thead><tr><th></th><th>Date</th><th>Type</th><th>Operator</th><th>Status</th></tr></thead>
				<tbody>${rows}</tbody></table>`,
		}));
	}

	if (children.length) {
		items.push(tlItem({
			id: 'children',
			when: dateRange(children, 'child_created'),
			title: `Sectioned into children <span class="count">${children.length}</span>`,
			body: `<div class="chips">${children
				.map((c) => `<span class="chip"><b>${esc(c.child_sample_code)}</b>${c.child_form ? ` <span class="rel">${esc(c.child_form)}</span>` : ''}${
					c.fraction ? ` <span class="frac">${num(c.fraction * 100, 0)}%</span>` : ''
				}<span class="chip-date">${fmtDate(c.child_created)}</span></span>`)
				.join('')}</div>`,
		}));
	}

	const notes = s.notes
		? `<section class="notes" id="block-notes" data-block="notes"><span class="k">Notes</span><p>${esc(s.notes)}</p></section>`
		: '';

	const exportBadge = s.export_controlled ? '<span class="badge danger">Export controlled</span>' : '';
	const statusBadge = s.current_status ? `<span class="badge">${esc(s.current_status)}</span>` : '';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Sample Overview — ${esc(s.sample_code)}</title>
<style>
	:root { --ink:#0f172a; --body:#1e293b; --muted:#64748b; --line:#e2e8f0; --soft:#f8fafc; --accent:#1d4ed8; --danger:#b91c1c; }
	* { box-sizing:border-box; }
	html,body { margin:0; padding:0; }
	body { font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--body); font-size:10.5px;
		line-height:1.45; -webkit-print-color-adjust:exact; print-color-adjust:exact; background:#eef2f6; }
	.doc { position:relative; width:210mm; min-height:297mm; margin:0 auto; padding:14mm 15mm; background:#fff; }
	.doc > * { position:relative; z-index:1; } /* keep content above the page-guide overlay */
	/* Print: page margins live on @page so EVERY page (not just the first) is inset,
	   and content no longer runs to the sheet edge on page 2+. */
	@page { size:A4; margin:14mm 15mm; }
	@media print {
		body { background:#fff; }
		.doc { width:auto; margin:0; padding:0; min-height:0; box-shadow:none; }
		.doc::before { display:none; }
		.no-print { display:none !important; }
		/* Keep small blocks whole… */
		.hd, .grid, .legend, .chips, .notes, .tl-item, figure { break-inside:avoid; }
		/* …but a timeline item holding a long op/test table MUST be allowed to flow
		   across pages, otherwise it jumps whole to the next page and leaves a gap. */
		.tl-item:has(.tbl) { break-inside:auto; }
		.tl-title, h2 { break-after:avoid; } /* a heading never sits alone at a page foot */
		.tbl { break-inside:auto; }
		.tbl thead { display:table-header-group; } /* repeat table headers on each page */
		.tbl tr { break-inside:avoid; }
	}
	@media screen {
		.doc { box-shadow:0 2px 16px rgba(15,23,42,.12); margin:16px auto; }
	}
	/* Page-gap spacer inserted by report.js at the REAL computed break point (see
	   the datasheet's own <style> for the full comment — same mechanism here). */
	.page-gap { width:100%; box-sizing:border-box; pointer-events:none;
		background:repeating-linear-gradient(45deg, #f1f5f9, #f1f5f9 6px, #e7ecf1 6px, #e7ecf1 12px);
		border-top:2px dashed #94a3b8; border-bottom:2px dashed #94a3b8; }
	@media print { .page-gap { display:none; } }

	/* Toolbar */
	.toolbar { position:sticky; top:0; z-index:10; display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:center;
		background:#fff; border-bottom:1px solid var(--line); padding:10px 16px; box-shadow:0 1px 8px rgba(15,23,42,.08);
		font:600 11px/1 -apple-system,"Segoe UI",Roboto,sans-serif; color:var(--body); }
	.toolbar label { display:flex; align-items:center; gap:5px; cursor:pointer; }
	.toolbar input { accent-color:var(--accent); }
	.tb-label { color:var(--muted); text-transform:uppercase; letter-spacing:.07em; font-size:9px; }
	.print-btn { cursor:pointer; font:600 11px/1 inherit; color:#fff; background:var(--accent); border:0; border-radius:7px;
		padding:8px 14px; box-shadow:0 2px 8px rgba(29,78,216,.3); }

	/* Header */
	.hd { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2.5px solid var(--accent);
		padding-bottom:12px; margin-bottom:16px; }
	.eyebrow { text-transform:uppercase; letter-spacing:.14em; font-size:9px; font-weight:700; color:var(--accent); margin-bottom:2px; }
	.code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:23px; font-weight:700; color:var(--ink); margin:0; }
	.subtitle { font-size:13px; font-weight:600; margin-top:3px; }
	.nickname { font-size:11px; color:var(--muted); font-style:italic; margin-top:1px; }
	.badges { margin-top:8px; display:flex; gap:6px; }
	.badge { display:inline-block; font-size:8.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; padding:2px 7px;
		border-radius:99px; background:var(--soft); color:var(--muted); border:1px solid var(--line); }
	.badge.danger { background:#fef2f2; color:var(--danger); border-color:#fecaca; }
	.hd-right { flex:0 0 auto; margin-left:16px; display:flex; align-items:center; gap:16px; }
	.qr-wrap { text-align:center; flex:0 0 auto; }
	.qr, .qr svg { width:74px; height:74px; display:block; }
	.uid { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:8.5px; color:var(--muted); margin-top:4px; }
	.geo-fig { margin:0; text-align:center; }
	.geo-fig svg { width:190px; height:auto; display:block; margin:0 auto; }
	/* isometric geometry engine classes (shared with the sample creator) */
	.gt { fill:#dbeafe; stroke:var(--accent); stroke-width:1.3; stroke-linejoin:round; }
	.gl { fill:#bfdbfe; stroke:var(--accent); stroke-width:1.3; stroke-linejoin:round; }
	.gr { fill:#93c5fd; stroke:var(--accent); stroke-width:1.3; stroke-linejoin:round; }
	.gh { fill:#fff; stroke:var(--accent); stroke-width:1.1; }
	.gdim { stroke:#64748b; stroke-width:0.8; }
	.gext { stroke:#94a3b8; stroke-width:0.5; }
	.gdimt { fill:#334155; font-size:8px; font-weight:700; text-anchor:middle; paint-order:stroke; stroke:#fff; stroke-width:2.5px; }
	.gsupport { fill:#94a3b8; stroke:#475569; stroke-width:0.6; }
	.gload { stroke:var(--danger); stroke-width:1.4; }
	.geo-fig figcaption { font-size:8px; color:var(--muted); margin-top:2px; text-transform:uppercase; letter-spacing:.05em; }

	/* Details grid */
	.grid { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1px solid var(--line);
		border-radius:6px; overflow:hidden; margin-bottom:18px; }
	.kv { background:#fff; padding:7px 9px; display:flex; flex-direction:column; }
	.kv .k { font-size:8px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); font-weight:600; }
	.kv .v { font-size:11.5px; font-weight:600; color:var(--ink); margin-top:1px; }
	.kv .sub { font-size:9px; color:var(--muted); }
	.unit { font-weight:400; color:var(--muted); font-size:9.5px; }

	h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink); border-bottom:1px solid var(--line);
		padding-bottom:4px; margin:0 0 12px; }

	/* Timeline */
	.timeline { position:relative; }
	.timeline::before { content:''; position:absolute; left:7px; top:6px; bottom:10px; width:2px;
		background:linear-gradient(var(--accent), var(--line)); }
	.tl-item { position:relative; padding-left:30px; margin-bottom:15px; page-break-inside:avoid; }
	.tl-dot { position:absolute; left:2px; top:2px; width:12px; height:12px; border-radius:50%; background:#fff;
		border:3px solid var(--line); box-sizing:border-box; }
	.tl-dot.cur { border-color:var(--accent); background:var(--accent); box-shadow:0 0 0 3px rgba(29,78,216,.15); }
	.tl-when { font-size:8.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--accent); }
	.tl-title { font-size:12px; font-weight:700; color:var(--ink); margin:1px 0 6px; display:flex; align-items:center; gap:8px; }
	.tl-title .count { font-size:9px; font-weight:700; color:#fff; background:var(--accent); border-radius:99px; padding:1px 7px; }
	.tl-note { color:var(--muted); font-size:10.5px; }

	/* Chips (origin / children) */
	.chips { display:flex; flex-wrap:wrap; gap:8px; }
	.chip { border:1px solid var(--line); border-radius:8px; padding:6px 10px; background:#fff; box-shadow:0 1px 2px rgba(15,23,42,.05);
		font-size:10px; display:flex; align-items:center; gap:6px; }
	.chip b { font-family:"SF Mono",Menlo,Consolas,monospace; }
	.chip .rel { font-size:8px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
	.chip .frac { color:var(--accent); font-weight:700; font-size:9px; }
	.chip-date { color:var(--muted); font-size:8.5px; border-left:1px solid var(--line); padding-left:6px; }

	/* Legend */
	.legend { display:flex; flex-wrap:wrap; gap:16px; margin-bottom:8px; font-size:9px; }
	.lg-grp { display:flex; align-items:center; gap:8px; }
	.lg-label { text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:700; font-size:8px; }
	.lg-item { display:inline-flex; align-items:center; gap:4px; color:var(--body); }
	.cdot { width:9px; height:9px; border-radius:50%; display:inline-block; }
	.pdot { width:9px; height:9px; border-radius:2px; display:inline-block; border:2px solid var(--muted); background:#fff; box-sizing:border-box; }
	.dots { display:inline-flex; gap:3px; align-items:center; }

	/* Tables */
	.tbl { width:100%; border-collapse:collapse; }
	.tbl thead th { text-align:left; font-size:8px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted);
		border-bottom:1.5px solid var(--line); padding:5px 8px; font-weight:700; }
	.tbl td { padding:4px 8px; border-bottom:1px solid var(--line); font-size:9.6px; vertical-align:middle; }
	.tbl tbody tr:nth-child(even) td { background:var(--soft); }
	.tbl td.n, .tbl thead th.n { text-align:right; }
	.tbl td.n { font-variant-numeric:tabular-nums; white-space:nowrap; }
	.tbl td.mono { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:8.6px; }
	.tbl td.dotcell { width:26px; padding-left:8px; padding-right:0; }

	/* Notes + footer */
	.notes { background:var(--soft); border-left:3px solid var(--accent); border-radius:4px; padding:8px 12px; margin:14px 0;
		page-break-inside:avoid; }
	.notes .k { font-size:8px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); font-weight:600; }
	.notes p { margin:2px 0 0; font-size:10.5px; }
	.foot { margin-top:16px; padding-top:8px; border-top:1px solid var(--line); display:flex; justify-content:space-between;
		font-size:8px; color:var(--muted); }
	.foot a { color:var(--muted); text-decoration:none; }
</style>
</head>
<body>
<div class="toolbar no-print">
	<span class="tb-label">Include:</span>
	<label><input type="checkbox" data-block="operations" checked /> Manufacturing</label>
	<label><input type="checkbox" data-block="tests" checked /> Testing</label>
	<label><input type="checkbox" data-block="children" checked /> Children</label>
	<label><input type="checkbox" data-block="notes" checked /> Notes</label>
	<button class="print-btn" id="printBtn">⤓ Save as PDF</button>
</div>
<div class="doc">
	<header class="hd">
		<div class="hd-left">
			<div class="eyebrow">Sample Overview</div>
			<h1 class="code">${esc(s.sample_code)}</h1>
			<div class="subtitle">${dash(s.material_name)}${s.form ? ` · ${esc(s.form)}` : ''}</div>
			${nickname ? `<div class="nickname">${esc(nickname)}</div>` : ''}
			<div class="badges">${statusBadge}${exportBadge}</div>
		</div>
		<div class="hd-right">
			<figure class="geo-fig">${buildGeometry(s, { labelSize: 11 })}<figcaption>${dims ? `${esc(dims)} mm` : esc(s.form || 'geometry')}</figcaption></figure>
			<div class="qr-wrap">
				<div class="qr">${qrSvg}</div>
				<div class="uid">ID ${esc(shortId)}</div>
			</div>
		</div>
	</header>
	<section class="grid">${details}</section>

	<h2>Sample Life</h2>
	<div class="timeline">${items.join('')}</div>

	${notes}

	<footer class="foot">
		<span>Generated ${fmtDate(new Date())} · STARbase LIMS</span>
		<a href="${esc(recordUrl)}">${esc(recordUrl)}</a>
	</footer>
</div>
<script src="/d1-report/report.js"></script>
</body>
</html>`;
}

// Per-kind parameter models: each process category / test type shows its own
// relevant parameters (label + unit). Only non-null values are rendered.
const CATEGORY_LABEL = {
	machining: 'Machining', sintering: 'FAST / Sintering', additive: 'Additive Manufacturing',
	deformation: 'Deformation', heat_treatment: 'Heat Treatment', sample_prep: 'Sample Preparation',
};
const OP_PARAM_GROUPS = {
	machining: [
		['machining_cutting_speed_m_per_min', 'Cutting speed (Vc)', 'm/min'], ['machining_feed_mm_per_rev', 'Feed', 'mm/rev'],
		['machining_spindle_speed_rpm', 'Spindle speed', 'rpm'], ['machining_axial_depth_of_cut_mm', 'Axial DoC', 'mm'],
		['machining_radial_depth_of_cut_mm', 'Radial DoC', 'mm'], ['machining_workpiece_diameter_mm', 'Workpiece Ø', 'mm'],
		['machining_cutting_length_mm', 'Cutting length', 'mm'], ['machining_coolant_pressure_bar', 'Coolant pressure', 'bar'],
		['machining_coolant_used', 'Coolant', ''], ['machining_new_edge', 'New edge', ''], ['machining_force_captured', 'Force captured', ''],
	],
	sintering: [
		['sintering_max_temp_celsius', 'Max temperature', '°C'], ['sintering_max_force_kn', 'Max force', 'kN'],
		['sintering_power_at_max_t_kw', 'Power at max T', 'kW'], ['sintering_voltage_at_max_t_v', 'Voltage at max T', 'V'],
		['sintering_mould_diameter_mm', 'Mould Ø', 'mm'], ['sintering_mass_grams', 'Powder mass', 'g'],
		['sintering_ptc_top_celsius', 'PTC top', '°C'], ['sintering_ptc_bot_celsius', 'PTC bottom', '°C'],
		['sintering_atmosphere', 'Atmosphere', ''], ['sintering_tc_pyro_control', 'TC / pyro control', ''],
		['sintering_recipe_number', 'Recipe', ''], ['sintering_batch_number', 'Batch', ''],
	],
	additive: [
		['am_process_variant', 'Variant', ''], ['am_laser_power_w', 'Laser power', 'W'], ['am_scan_speed_mm_per_s', 'Scan speed', 'mm/s'],
		['am_energy_density_j_per_mm3', 'Energy density', 'J/mm³'], ['am_hatch_spacing_mm', 'Hatch spacing', 'mm'],
		['am_layer_thickness_mm', 'Layer thickness', 'mm'], ['am_preheat_temp_celsius', 'Preheat', '°C'], ['am_build_atmosphere', 'Atmosphere', ''],
	],
	deformation: [
		['deform_deformation_type', 'Type', ''], ['deform_deformation_temp_celsius', 'Temperature', '°C'],
		['deform_strain_rate_per_sec', 'Strain rate', '/s'], ['deform_roll_speed_m_per_min', 'Roll speed', 'm/min'],
		['deform_total_reduction_pct', 'Total reduction', '%'], ['deform_reduction_per_pass_pct', 'Reduction / pass', '%'],
		['deform_pass_count', 'Passes', ''], ['deform_lubricant', 'Lubricant', ''],
	],
	heat_treatment: [
		['ht_treatment_type', 'Treatment', ''], ['ht_peak_temp_celsius', 'Peak temperature', '°C'], ['ht_hold_time_min', 'Hold time', 'min'],
		['ht_heating_rate_c_per_min', 'Heating rate', '°C/min'], ['ht_cooling_rate_c_per_min', 'Cooling rate', '°C/min'],
		['ht_cooling_method', 'Cooling method', ''], ['ht_quench_medium', 'Quench medium', ''], ['ht_atmosphere', 'Atmosphere', ''],
	],
};
const TEST_PARAM_GROUPS = {
	tensile: [
		['tensile_specimen_geometry', 'Specimen geometry', ''], ['tensile_gauge_length_mm', 'Gauge length', 'mm'],
		['tensile_gauge_diameter_mm', 'Gauge Ø', 'mm'], ['tensile_test_temp_celsius', 'Temperature', '°C'],
		['tensile_crosshead_speed_mm_per_min', 'Crosshead speed', 'mm/min'], ['tensile_strain_rate_per_s', 'Strain rate', '/s'],
		['tensile_yield_strength_mpa', 'Yield strength', 'MPa'], ['tensile_uts_mpa', 'UTS', 'MPa'],
		['tensile_elongation_pct', 'Elongation', '%'], ['tensile_reduction_of_area_pct', 'Reduction of area', '%'],
		['tensile_youngs_modulus_gpa', "Young's modulus", 'GPa'], ['tensile_fracture_mode', 'Fracture mode', ''],
	],
	hardness: [
		['hardness_hardness_scale', 'Scale', ''], ['hardness_load_gf', 'Load', 'gf'], ['hardness_dwell_time_s', 'Dwell', 's'],
		['hardness_indenter_type', 'Indenter', ''], ['hardness_n_indentations', 'Indentations', ''],
		['hardness_mean_hardness', 'Mean', ''], ['hardness_std_dev_hardness', 'Std dev', ''],
		['hardness_min_hardness', 'Min', ''], ['hardness_max_hardness', 'Max', ''],
	],
	charpy: [
		['charpy_specimen_standard', 'Standard', ''], ['charpy_notch_type', 'Notch', ''], ['charpy_test_temp_celsius', 'Temperature', '°C'],
		['charpy_orientation', 'Orientation', ''], ['charpy_absorbed_energy_j', 'Absorbed energy', 'J'],
		['charpy_lateral_expansion_mm', 'Lateral expansion', 'mm'], ['charpy_shear_fracture_pct', 'Shear fracture', '%'],
	],
	compression: [
		['compression_specimen_diameter_mm', 'Specimen Ø', 'mm'], ['compression_specimen_height_mm', 'Height', 'mm'],
		['compression_crosshead_speed_mm_per_min', 'Crosshead speed', 'mm/min'], ['compression_strain_rate_per_s', 'Strain rate', '/s'],
		['compression_test_temp_celsius', 'Temperature', '°C'], ['compression_yield_strength_mpa', 'Yield strength', 'MPa'],
		['compression_peak_stress_mpa', 'Peak stress', 'MPa'], ['compression_strain_at_fracture_pct', 'Strain at fracture', '%'],
	],
	sem: [
		['sem_imaging_mode', 'Imaging mode', ''], ['sem_accelerating_voltage_kv', 'Accel. voltage', 'kV'],
		['sem_working_distance_mm', 'Working distance', 'mm'], ['sem_magnification_range', 'Magnification', ''],
		['sem_coating_material', 'Coating', ''], ['sem_etchant', 'Etchant', ''],
	],
	xrd: [
		['xrd_radiation_source', 'Source', ''], ['xrd_wavelength_angstrom', 'Wavelength', 'Å'], ['xrd_two_theta_range_deg', '2θ range', '°'],
		['xrd_step_size_deg', 'Step size', '°'], ['xrd_scan_speed_deg_per_min', 'Scan speed', '°/min'], ['xrd_detector_type', 'Detector', ''],
	],
};

function paramCells(row, defs) {
	return (defs || [])
		.filter(([col]) => row[col] !== null && row[col] !== undefined && row[col] !== '')
		.map(([col, label, unit]) => `<div class="pcell"><span class="pk">${esc(label)}</span><span class="pv">${num(row[col], 3)}${
			unit ? ` <span class="unit">${esc(unit)}</span>` : ''
		}</span></div>`)
		.join('');
}

// Shared one-page datasheet used by both operation and test reports. `extraToggles`
// (checkbox <label> html) and `extraBlocks` (the matching id="block-X" sections,
// appended after Notes) are optional — only the operation report's force/FFT/FRM
// appendix uses them; the generic REPORT_JS toggle wiring (index.js) needs no changes.
function datasheetHtml({ eyebrow, code, subtitle, details, paramTitle, params, notes, qrSvg, recordUrl, shortId, extraToggles, extraBlocks }) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>${esc(eyebrow)} — ${esc(code)}</title>
<style>
	:root { --ink:#0f172a; --body:#1e293b; --muted:#64748b; --line:#e2e8f0; --soft:#f8fafc; --accent:#1d4ed8; }
	* { box-sizing:border-box; } html,body { margin:0; padding:0; }
	body { font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; color:var(--body); font-size:10.5px; line-height:1.45;
		-webkit-print-color-adjust:exact; print-color-adjust:exact; background:#eef2f6; }
	.doc { position:relative; width:210mm; min-height:297mm; margin:0 auto; padding:16mm; background:#fff; }
	.doc > * { position:relative; z-index:1; }
	@page { size:A4; margin:16mm; }
	@media print {
		body { background:#fff; }
		.doc { width:auto; margin:0; padding:0; min-height:0; box-shadow:none; }
		.doc::before { display:none; }
		.no-print { display:none !important; }
		.hd, .grid, .notes, figure, h2, .pcell { break-inside:avoid; }
		h2 { break-after:avoid; }
		.tbl thead { display:table-header-group; }
		.tbl tr { break-inside:avoid; }
	}
	@media screen {
		.doc { box-shadow:0 2px 16px rgba(15,23,42,.12); margin:16px auto; }
	}
	/* Page-gap spacers: scripts/matlab-report.js measures REAL rendered heights and
	   inserts one of these, sized to fill the rest of the current page, immediately
	   before whatever unit would actually overflow onto the next printed page — so
	   the on-screen preview shows a genuine gap exactly where content moves, not a
	   static line that can drift out of sync with the real content. */
	.page-gap { width:100%; box-sizing:border-box; pointer-events:none;
		background:repeating-linear-gradient(45deg, #f1f5f9, #f1f5f9 6px, #e7ecf1 6px, #e7ecf1 12px);
		border-top:2px dashed #94a3b8; border-bottom:2px dashed #94a3b8; }
	@media print { .page-gap { display:none; } }
	.toolbar { position:sticky; top:0; z-index:10; display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:center;
		background:#fff; border-bottom:1px solid var(--line); padding:10px; box-shadow:0 1px 8px rgba(15,23,42,.08); }
	.toolbar label { display:flex; align-items:center; gap:5px; cursor:pointer; font-size:11px; }
	.toolbar input { accent-color:var(--accent); }
	.tb-label { color:var(--muted); text-transform:uppercase; letter-spacing:.07em; font-size:9px; }
	.print-btn { cursor:pointer; font:600 11px/1 -apple-system,"Segoe UI",Roboto,sans-serif; color:#fff; background:var(--accent);
		border:0; border-radius:7px; padding:8px 14px; box-shadow:0 2px 8px rgba(29,78,216,.3); }
	/* Compact "Plots ▾" dropdown instead of a bare row of 9-10 checkboxes. */
	.fa-menu { position:relative; }
	.fa-menu-btn { cursor:pointer; font:600 11px/1 -apple-system,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:#fff;
		border:1px solid var(--line); border-radius:7px; padding:8px 12px; display:flex; align-items:center; gap:6px; }
	.fa-menu-count { background:var(--accent); color:#fff; border-radius:99px; font-size:9px; font-weight:700; padding:1px 6px; }
	.fa-menu-panel { display:none; position:absolute; top:calc(100% + 4px); left:0; background:#fff; border:1px solid var(--line);
		border-radius:8px; box-shadow:0 8px 24px rgba(15,23,42,.18); padding:6px 2px; z-index:20; min-width:150px; }
	.fa-menu-panel label { display:flex; align-items:center; gap:7px; padding:6px 12px; font-size:11.5px; cursor:pointer; white-space:nowrap; }
	.fa-menu-panel label:hover { background:var(--soft); }
	.fa-menu.open .fa-menu-panel { display:block; }
	/* Force graphs left / FFT right, one atomic row per axis (page-break-inside:avoid
	   so a row moves to the next page as a whole, never splits mid-chart). report.js
	   toggles grid-template-columns to 1fr when a whole side is empty (via the
	   #faRows.all-force-hidden / .all-fft-hidden classes) so the remaining side fills
	   the row instead of leaving a blank half. */
	.fa-rows { display:flex; flex-direction:column; gap:8px; margin-bottom:8px; }
	.fa-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; page-break-inside:avoid; break-inside:avoid; }
	.fa-row-solo { grid-template-columns:1fr; }
	#faRows.all-force-hidden .fa-row:not(.fa-row-solo) { grid-template-columns:1fr; }
	#faRows.all-fft-hidden .fa-row:not(.fa-row-solo) { grid-template-columns:1fr; }
	.force-chart { border:1px solid var(--line); border-radius:6px; padding:6px 8px; min-width:0; }
	.force-chart .fc-title { font-size:8.5px; font-weight:700; color:var(--ink); margin-bottom:2px; }
	.force-chart svg { display:block; width:100%; height:auto; }
	.force-chart .tick { font-size:6.5px; fill:var(--muted); }
	.force-chart .axislabel { font-size:7px; fill:var(--muted); font-weight:600; }
	/* auto-fit + minmax(_,1fr): fewer visible figures grow to fill the row width as
	   items are toggled off — but each figure is capped so a LONE one doesn't blow up
	   to the full row width (an FRM map is ~square, so full-width would make it very
	   tall and push it onto the next page). */
	.frm-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; justify-items:center; }
	.frm-fig { border:1px solid var(--line); border-radius:6px; padding:6px; text-align:center; page-break-inside:avoid; break-inside:avoid;
		max-width:210px; width:100%; box-sizing:border-box; }
	.frm-fig img { width:100%; height:auto; border-radius:4px; }
	.frm-fig figcaption { font-size:8.5px; font-weight:700; color:var(--ink); margin-top:3px; }
	/* FAST sintering trace plots (hydrated client-side by report.js from the CSV). */
	.fast-plots { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
	.fp-plot { border:1px solid var(--line); border-radius:6px; padding:6px 8px; page-break-inside:avoid; break-inside:avoid; min-width:0; }
	.fp-plot .fp-title { font-size:8.5px; font-weight:700; color:var(--ink); margin-bottom:2px; }
	.fp-plot svg { display:block; width:100%; height:auto; }
	.fp-plot .fp-tick { font-size:6.5px; fill:var(--muted); }
	.fp-legend { display:flex; flex-wrap:wrap; gap:2px 8px; margin-top:2px; }
	.fp-legend span { display:inline-flex; align-items:center; gap:3px; font-size:7.5px; color:var(--ink); }
	.fp-legend i { width:8px; height:3px; border-radius:2px; display:inline-block; }
	.fp-msg { grid-column:1 / -1; color:var(--muted); font-size:10px; padding:8px; text-align:center; }
	.hd { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2.5px solid var(--accent); padding-bottom:12px; margin-bottom:16px; }
	.eyebrow { text-transform:uppercase; letter-spacing:.14em; font-size:9px; font-weight:700; color:var(--accent); }
	.code { font-family:"SF Mono",Menlo,Consolas,monospace; font-size:20px; font-weight:700; color:var(--ink); margin:2px 0 0; }
	.subtitle { font-size:13px; font-weight:600; margin-top:3px; }
	.qr,.qr svg { width:70px; height:70px; display:block; } .uid { font-family:monospace; font-size:8.5px; color:var(--muted); margin-top:4px; text-align:center; }
	.grid { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--line); border:1px solid var(--line); border-radius:6px; overflow:hidden; margin-bottom:18px; }
	.kv { background:#fff; padding:7px 9px; display:flex; flex-direction:column; }
	.kv .k { font-size:8px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); font-weight:600; }
	.kv .v { font-size:11.5px; font-weight:600; color:var(--ink); margin-top:1px; } .kv .v a { color:var(--accent); text-decoration:none; }
	.kv .sub { font-size:9px; color:var(--muted); }
	h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink); border-bottom:1px solid var(--line); padding-bottom:4px; margin:0 0 10px; }
	.params { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
	.pcell { border:1px solid var(--line); border-radius:8px; padding:9px 11px; display:flex; flex-direction:column; }
	.pk { font-size:8px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
	.pv { font-size:15px; font-weight:700; color:var(--ink); margin-top:3px; } .unit { font-size:9px; font-weight:400; color:var(--muted); }
	.notes { background:var(--soft); border-left:3px solid var(--accent); border-radius:4px; padding:8px 12px; margin-top:16px; }
	.notes .k { font-size:8px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); font-weight:600; } .notes p { margin:2px 0 0; }
	.foot { margin-top:18px; padding-top:8px; border-top:1px solid var(--line); display:flex; justify-content:space-between; font-size:8px; color:var(--muted); }
	.foot a { color:var(--muted); text-decoration:none; }
</style></head>
<body>
<div class="toolbar no-print">
	${extraToggles ? `<span class="tb-label">Include:</span>${extraToggles}` : ''}
	<button class="print-btn" id="printBtn">⤓ Save as PDF</button>
</div>
<div class="doc">
	<header class="hd">
		<div>
			<div class="eyebrow">${esc(eyebrow)}</div>
			<h1 class="code">${code}</h1>
			<div class="subtitle">${subtitle}</div>
		</div>
		<div><div class="qr">${qrSvg}</div><div class="uid">ID ${esc(shortId)}</div></div>
	</header>
	<section class="grid">${details}</section>
	${params ? `<h2>${esc(paramTitle)}</h2><section class="params">${params}</section>` : ''}
	${notes}
	${extraBlocks || ''}
	<footer class="foot"><span>Generated ${fmtDate(new Date())} · STARbase LIMS</span><a href="${esc(recordUrl)}">${esc(recordUrl)}</a></footer>
</div>
<script src="/d1-report/report.js"></script>
</body></html>`;
}

const kvCell = (label, value, sub) =>
	`<div class="kv"><span class="k">${esc(label)}</span><span class="v">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;

const FORCE_AXIS_COLOR = { Fx: '#dc2626', Fy: '#16a34a', Fz: '#2563eb', RPM: '#a855f7' };

// The force/FFT/FRM appendix for a machining operation with a processed
// machining_force_analysis row (`fa`). Every one of the up-to-10 plots (3 force
// + RPM + 3 FFT + 3 FRM) gets its own checkbox in a compact dropdown menu.
// Force+FFT render as PAIRED ROWS (force left cell, FFT right cell, one row per
// axis) — each row is a single atomic print unit (page-break-inside:avoid), so
// a row moves to the next page as a whole rather than splitting mid-content.
// report.js additionally collapses a row/section to full width if its whole
// force or FFT side is empty, and caps a lone FRM figure's size. Returns
// {toggles, blocks}, both '' if there's nothing to show.
function forceAppendix(fa, publicUrl) {
	if (!fa || fa.status !== 'done') return { toggles: '', blocks: '' };

	const cropStart = fa.sample_rate && fa.cut_start_idx != null ? fa.cut_start_idx / fa.sample_rate : null;
	const cropEnd = fa.sample_rate && fa.cut_end_idx != null ? fa.cut_end_idx / fa.sample_rate : null;

	const axes = ['Fx', 'Fy', 'Fz'];
	const hasForce = (a) => fa.series?.[a]?.t?.length;
	const hasFft = (a) => fa.fft?.[a]?.f?.length;
	const hasFrm = (a) => fa[`frm_${a.toLowerCase()}`];
	const hasRpm = fa.series?.RPM?.t?.length;

	const plotCell = (key, label, svg) =>
		svg ? `<div class="force-chart" id="block-${key}" data-block="${key}"><div class="fc-title">${esc(label)}</div>${svg}</div>` : '';

	const rows = axes.filter((a) => hasForce(a) || hasFft(a)).map((a) => {
		const left = hasForce(a) ? plotCell(`force-${a}`, `${a} · force`, miniEnvelopeSvg(fa.series[a], { color: FORCE_AXIS_COLOR[a], cropStart, cropEnd })) : '';
		const right = hasFft(a) ? plotCell(`fft-${a}`, `${a} · spectrum (log)`, miniFftSvg(fa.fft[a], { color: FORCE_AXIS_COLOR[a] })) : '';
		return `<div class="fa-row">${left}${right}</div>`;
	});
	if (hasRpm) {
		rows.push(`<div class="fa-row fa-row-solo">${plotCell('force-RPM', 'RPM', miniEnvelopeSvg(fa.series.RPM, { color: FORCE_AXIS_COLOR.RPM, yUnit: 'rpm' }))}</div>`);
	}

	const frmFigs = axes.filter(hasFrm).map((a) => {
		const fid = fa[`frm_${a.toLowerCase()}`];
		return `<figure class="frm-fig" id="block-frm-${a}" data-block="frm-${a}">
			<img src="${esc(publicUrl)}/assets/${esc(fid)}" alt="FRM ${a}" /><figcaption>FRM — ${a}</figcaption>
		</figure>`;
	}).join('');

	if (!rows.length && !frmFigs) return { toggles: '', blocks: '' };

	const toggle = (key, label, checked = true) =>
		`<label><input type="checkbox" data-block="${key}"${checked ? ' checked' : ''} /> ${esc(label)}</label>`;
	const toggleItems = [
		...axes.filter(hasForce).map((a) => toggle(`force-${a}`, `${a} force`)),
		hasRpm ? toggle('force-RPM', 'RPM') : '',
		...axes.filter(hasFft).map((a) => toggle(`fft-${a}`, `${a} FFT`)),
		...axes.filter(hasFrm).map((a) => toggle(`frm-${a}`, `${a} FRM`)),
	].filter(Boolean).join('');

	// A compact dropdown ("Plots ▾") rather than a bare row of checkboxes —
	// report.js toggles `.fa-menu-open` on click/outside-click.
	const toggles = `<div class="fa-menu">
		<button type="button" class="fa-menu-btn" id="faMenuBtn">Plots <span class="fa-menu-count">${toggleItems.split('<label>').length - 1}</span> ▾</button>
		<div class="fa-menu-panel" id="faMenuPanel">${toggleItems}</div>
	</div>`;

	const blocks = `<section>
		<h2>Force Analysis</h2>
		${rows.length ? `<div class="fa-rows" id="faRows">${rows.join('')}</div>` : ''}
		${frmFigs ? `<div class="frm-grid" id="faFrmGrid">${frmFigs}</div>` : ''}
	</section>`;

	return { toggles, blocks };
}

// The FAST sintering trace appendix. The normalised trace CSV is large, so rather
// than embed data server-side we hand report.js the file id + series catalog + the
// default plot groups; it fetches the CSV same-origin and draws the line charts
// (see REPORT_JS). Returns {toggles, blocks}, both '' if there's no trace.
function fastAppendix(fastRun) {
	if (!fastRun || fastRun.status !== 'done' || !fastRun.directus_files_id) return { toggles: '', blocks: '' };
	const cat = Array.isArray(fastRun.series) ? fastRun.series : [];
	const pick = (groups, n) => cat.filter((c) => groups.includes(c.group)).map((c) => c.key).slice(0, n);
	const plots = [];
	const temps = pick(['temp'], 5);
	if (temps.length) plots.push({ title: 'Temperature', keys: temps });
	const fp = pick(['force', 'power'], 4);
	if (fp.length) plots.push({ title: 'Force / power', keys: fp });
	const pr = pick(['pressure'], 3);
	if (pr.length) plots.push({ title: 'Pressure / vacuum', keys: pr });
	if (!plots.length) return { toggles: '', blocks: '' };

	const attr = (v) => esc(JSON.stringify(v));
	const toggles = `<label><input type="checkbox" data-block="fast-trace" checked /> Trace plots</label>`;
	const blocks = `<section data-block="fast-trace">
		<h2>Sintering trace</h2>
		<div class="fast-plots" data-file="${esc(fastRun.directus_files_id)}" data-catalog='${attr(cat)}' data-plots='${attr(plots)}'>
			<div class="fp-msg">Loading trace…</div>
		</div>
	</section>`;
	return { toggles, blocks };
}

export function renderOperationReport(d) {
	const { op: o, qrSvg, recordUrl, publicUrl, fa, fastRun } = d;
	const shortId = String(o.operation_id).split('-')[0];
	const sampleUrl = `${publicUrl}/admin/content/physical_samples/${o.sample_id}`;
	const catLabel = CATEGORY_LABEL[o.process_category] || (o.process_category ? esc(o.process_category) : 'Operation');

	const details = [
		kvCell('Sample', o.sample_id ? `<a href="${esc(sampleUrl)}">${dash(o.sample_code)}</a>` : dash(o.sample_code)),
		kvCell('Process', catLabel),
		kvCell('Method', dash(o.method_name), o.method_code ? esc(o.method_code) : ''),
		kvCell('Sub-type', dash(o.machining_operation_subtype)),
		kvCell('Date', fmtDate(o.operation_date)),
		kvCell('Operator', dash(o.operator_name)),
		kvCell('Project', dash(o.project_code), o.project_name ? esc(o.project_name) : ''),
		kvCell('Campaign', dash(o.campaign_name || o.campaign_code)),
		kvCell('Equipment', dash(o.equipment_name || o.equipment_code)),
		kvCell('Tool', dash(o.tool_code)),
		kvCell('Insert / edge', [o.insert_code, o.insert_edge_code].filter(Boolean).map(esc).join(' · ') || '—'),
		kvCell('Force file', dash(o.force_file_id)),
		// The .mat file's own recorded time (metadata.TriggerTime), when present —
		// distinct from operation_date, which for legacy imports is often just the
		// sample record's creation time.
		fa?.trigger_time ? kvCell('Recorded', fmtDateTime(fa.trigger_time)) : '',
	].filter(Boolean).join('');

	// Machining ops get the force/FFT/FRM appendix; sintering (FAST) ops get the
	// trace-plot appendix instead (an op is one or the other).
	const app = o.process_category === 'sintering'
		? fastAppendix(fastRun)
		: forceAppendix(fa, publicUrl);
	const { toggles: extraToggles, blocks: extraBlocks } = app;

	return datasheetHtml({
		eyebrow: `${catLabel} Operation`,
		code: dash(o.pass_code),
		subtitle: `${dash(o.method_name)}${o.machining_operation_subtype ? ` · ${esc(o.machining_operation_subtype)}` : ''}`,
		details,
		paramTitle: `${catLabel} Parameters`,
		params: paramCells(o, OP_PARAM_GROUPS[o.process_category]),
		notes: o.outcome_notes ? `<section class="notes"><span class="k">Outcome notes</span><p>${esc(o.outcome_notes)}</p></section>` : '',
		qrSvg, recordUrl, shortId,
		extraToggles, extraBlocks,
	});
}

export function renderTestReport(d) {
	const { test: t, qrSvg, recordUrl, publicUrl } = d;
	const shortId = String(t.session_id).split('-')[0];
	const sampleUrl = `${publicUrl}/admin/content/physical_samples/${t.sample_id}`;
	const typeLabel = t.test_type ? String(t.test_type).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Test';

	const details = [
		kvCell('Sample', t.sample_id ? `<a href="${esc(sampleUrl)}">${dash(t.sample_code)}</a>` : dash(t.sample_code)),
		kvCell('Test type', esc(typeLabel)),
		kvCell('Date', fmtDate(t.session_date)),
		kvCell('Operator', dash(t.operator_name)),
		kvCell('Status', dash(t.status)),
		kvCell('Project', dash(t.project_code), t.project_name ? esc(t.project_name) : ''),
		kvCell('Campaign', dash(t.campaign_name || t.campaign_code)),
		kvCell('Equipment', dash(t.equipment_name || t.equipment_code)),
		kvCell('Data file', dash(t.data_file_uri || t.file_storage_pointer)),
		kvCell('File size', t.data_file_size_gb || t.file_size_gb ? `${num(t.data_file_size_gb || t.file_size_gb, 2)} GB` : '—'),
	].join('');

	return datasheetHtml({
		eyebrow: `${typeLabel} Test`,
		code: dash(t.sample_code || shortId),
		subtitle: `${typeLabel} · ${fmtDate(t.session_date)}`,
		details,
		paramTitle: `${typeLabel} Parameters & Results`,
		params: paramCells(t, TEST_PARAM_GROUPS[t.test_type]),
		notes: t.notes ? `<section class="notes"><span class="k">Notes</span><p>${esc(t.notes)}</p></section>` : '',
		qrSvg, recordUrl, shortId,
	});
}

function tlItem({ id, when, title, body, current }) {
	return `<div class="tl-item"${id ? ` id="block-${id}" data-block="${id}"` : ''}>
		<span class="tl-dot${current ? ' cur' : ''}"></span>
		<div class="tl-when">${when || ''}</div>
		<div class="tl-title">${title}</div>
		${body || ''}
	</div>`;
}
