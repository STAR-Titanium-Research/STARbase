// The Conform run appendix of the operation datasheet, and the reader of the stored Conform CSV it plots.
// Split out of render.js (review round 1 of docs/superpowers/plans/2026-10-21-conform-runs.md).

import { esc } from './util.js';
import { CONFORM_FIGURES, DASH, figureNumber, formatDuration, formatFigure, niceNumber } from './conformFigures.js';

// ---------------------------------------------------------------------------
// Conform (continuous extrusion) run appendix.
//
// Unlike the FAST appendix (hydrated in the browser), the endpoint reads the
// stored CSV through the caller's accountability and hands `conformAppendix` the
// parsed trace, so the plots are plain server-rendered SVG. The run summary and
// steps are always shown; the plots area says why there are none:
//   - "Conform log not visible to you." only when the read of the log row or of its
//     file was FORBIDDEN (a 403: the file is owned by someone the caller cannot read as);
//   - "Could not load the Conform log." for any other failure (missing file, storage
//     error, an empty or unreadable CSV);
//   - "Run window too short to plot." when the window holds fewer than 2 rows.
// The formats are the shared ones of the Conform plan (Operation page, plotter, PDF), from the
// mirrored figure table in conformFigures.js: labels in sentence case, numbers by DESIGN 5b
// (integers from 100, one decimal from 10, up to two below, no trailing zeros), energy and demand
// to 2 decimals, durations as "12 min 05 s" under an hour and "1 h 23 min" from an hour, an em
// dash with no unit for no reading, clock times HH:MM:SS in UK time, dates as "17 Mar 2025".
// The plots follow the chart rules of DESIGN 5b: solid axis lines with outward ticks, hairline
// gridlines at every tick, nice steps (1, 2, 2.5, 5 x 10^n), 5 to 6 per axis, the top tick above
// the data, real minus signs, a title with its unit on every axis. The time axis is elapsed
// minutes since the log start, as on the plotter. The series colours are the report's own (the
// FAST appendix uses the same ones), a deliberate exception to the app palette on white paper.
// The CSV is the normalised file written by packages/fast-plotting/src/conform:
// header row, first column `time_s` (seconds from log_start), then one column
// per entry of conform_logs.series, in order.
// ---------------------------------------------------------------------------

export const CONFORM_LOG_HIDDEN = 'Conform log not visible to you.';
export const CONFORM_LOG_FAILED = 'Could not load the Conform log.';
export const CONFORM_WINDOW_SHORT = 'Run window too short to plot.';
export const CONFORM_NO_CHANNELS = 'This log has none of the channels the plots use.';

/** Parse the normalised Conform CSV: {time: number[], cols: {key: number[]}} (blank cell = NaN). */
export function parseConformCsv(text, series) {
	const keys = (series || []).map((c) => c.key);
	const time = [];
	const cols = {};
	for (const k of keys) cols[k] = [];
	const lines = String(text || '').split(/\r?\n/);
	for (let r = 1; r < lines.length; r++) {
		if (!lines[r]) continue;
		const cells = lines[r].split(',');
		const t = Number(cells[0]);
		if (!Number.isFinite(t)) continue;
		time.push(t);
		for (let i = 0; i < keys.length; i++) {
			const c = cells[i + 1];
			cols[keys[i]].push(c === undefined || c === '' ? NaN : Number(c));
		}
	}
	return { time, cols };
}

const UK_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const UK_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' });
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
/** HH:MM:SS in UK local time (Europe/London); '' for an invalid instant. */
const ukTime = (t) => { const ms = toMs(t); return Number.isFinite(ms) ? UK_TIME.format(ms) : ''; };
/** "17 Mar 2025, 13:38:20" in UK local time; '' for an invalid instant. */
const ukDateTime = (t) => { const ms = toMs(t); return Number.isFinite(ms) ? `${UK_DATE.format(ms)}, ${UK_TIME.format(ms)}` : ''; };

const CONFORM_COLORS = ['#dc2626', '#2563eb', '#16a34a', '#d97706'];
const CONFORM_DEFAULT_LABEL = {
	wheel_speed_rpm: 'Wheel speed', wheel_speed_demand_rpm: 'Wheel speed demand', motor_torque_pct: 'Motor torque',
	tooling1_c: 'Tooling 1 (behind abutment)', tooling2_c: 'Tooling 2 (die exit)', wheel_temp_c: 'Wheel temperature', ips_output_pct: 'IPS output',
};
const CONFORM_PANELS = [
	{ title: 'Wheel speed', keys: ['wheel_speed_rpm', 'wheel_speed_demand_rpm'] },
	{ title: 'Motor torque', keys: ['motor_torque_pct'] },
	{ title: 'Temperatures', keys: ['tooling1_c', 'tooling2_c', 'wheel_temp_c'] },
	{ title: 'IPS output', keys: ['ips_output_pct'] },
];

// Rows [from, to) with start <= t < end; a window that reaches the last row includes it
// (same rule as windowRows in packages/fast-plotting/src/conform/summary.ts).
function conformWindowRows(time, logStartMs, startMs, endMs) {
	const n = time.length;
	if (!n) return [0, 0];
	const t0 = (startMs - logStartMs) / 1000;
	const t1 = (endMs - logStartMs) / 1000;
	let from = 0;
	while (from < n && time[from] < t0) from++;
	let to = from;
	while (to < n && time[to] < t1) to++;
	if (t1 >= time[n - 1] && to === n - 1) to = n;
	return [from, Math.max(from, to)];
}

const MINUS = '−';
const STEPS = [1, 2, 2.5, 5];

// Nice tick values for [lo, hi]: steps of 1, 2, 2.5 or 5 x 10^n, with the count nearest to 5.5 (5 or 6 where the range allows).
//   cover: a y axis. The first tick is at or below `lo` and the last at or above `hi` (the top tick above the data); when that gives
//          fewer or more than 5 to 6, one extra step below or above is allowed, so the axis can reach 5 or 6.
//   else:  a time axis, which cannot run past its window: only ticks inside [lo, hi].
// On a tie the rounder step wins (1, 2, 5, then 2.5). Returns {ticks, step}.
export function niceTicks(lo, hi, { cover = false } = {}) {
	if (!(hi > lo)) return { ticks: [lo], step: 1 };
	let best = null;
	const e0 = Math.floor(Math.log10((hi - lo) / 12));
	for (let e = e0; e <= e0 + 3; e++) {
		for (const m of STEPS) {
			const step = m * 10 ** e;
			const first = (cover ? Math.floor(lo / step + 1e-9) : Math.ceil(lo / step - 1e-9)) * step;
			const last = (cover ? Math.ceil(hi / step - 1e-9) : Math.floor(hi / step + 1e-9)) * step;
			const base = Math.round((last - first) / step) + 1;
			const rank = { 1: 0, 2: 1, 5: 2, 2.5: 3 }[m];
			for (const [below, above] of cover ? [[0, 0], [1, 0], [0, 1]] : [[0, 0]]) {
				const count = base + below + above;
				if (count < 2) continue;
				const cost = count >= 5 && count <= 6 ? 0 : Math.abs(count - 5.5);
				const extra = below + above;
				const better = !best || cost < best.cost - 1e-9
					|| (Math.abs(cost - best.cost) <= 1e-9 && (extra < best.extra || (extra === best.extra && rank < best.rank)));
				if (better) best = { cost, count, step, first: first - below * step, rank, extra };
			}
		}
	}
	if (!best) return { ticks: [lo, hi], step: hi - lo };
	const ticks = [];
	for (let i = 0; i < best.count; i++) ticks.push(Number((best.first + i * best.step).toPrecision(12)));
	return { ticks, step: best.step };
}

/** A tick label with as many decimals as the step needs (so every label on an axis has the same), and a real minus sign. */
export function tickLabel(v, step) {
	const pow = 10 ** Math.floor(Math.log10(step) + 1e-9);
	const decimals = Math.min(6, Math.max(0, -Math.round(Math.log10(pow)) + (Math.abs(step / pow - 2.5) < 1e-9 ? 1 : 0)));
	const text = (Math.abs(v) < step * 1e-9 ? 0 : v).toFixed(decimals);
	return text.startsWith('-') ? MINUS + text.slice(1) : text;
}

function conformPanelSvg(lines, time, logStartMs, from, to, yUnit) {
	const W = 300, H = 158, ML = 34, MR = 10, MT = 13, MB = 27;
	let lo = Infinity, hi = -Infinity;
	for (const l of lines) for (let i = from; i < to; i++) { const v = l.values[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
	if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
	if (lo === hi) { lo -= 1; hi += 1; }
	const yAxis = niceTicks(lo, hi, { cover: true });
	const yLo = yAxis.ticks[0], yHi = yAxis.ticks[yAxis.ticks.length - 1];
	// elapsed minutes since the log start (the plotter's axis), over the window only
	const t0 = time[from] / 60, t1 = time[to - 1] / 60;
	const xAxis = niceTicks(t0, t1);
	const plotW = W - ML - MR, plotH = H - MT - MB;
	const sx = (x) => ML + ((x - t0) / (t1 - t0 || 1)) * plotW;
	const sy = (v) => MT + (1 - (v - yLo) / (yHi - yLo || 1)) * plotH;
	const stride = Math.max(1, Math.floor((to - from) / 400));
	const ln = (x1, y1, x2, y2, stroke, w) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${w}"/>`;
	let svg = `<svg viewBox="0 0 ${W} ${H}">`;
	// gridlines at every labelled tick (solid hairlines), then the series, then the axes and labels on top
	for (const v of yAxis.ticks) svg += ln(ML, sy(v), W - MR, sy(v), '#edf0f2', 0.5);
	for (const v of xAxis.ticks) svg += ln(sx(v), MT, sx(v), H - MB, '#edf0f2', 0.5);
	lines.forEach((l, k) => {
		let d = '', pen = false;
		for (let i = from; i < to; i += stride) {
			const v = l.values[i];
			if (!Number.isFinite(v)) { pen = false; continue; }
			d += `${pen ? 'L' : 'M'}${sx(time[i] / 60).toFixed(1)},${sy(v).toFixed(1)} `;
			pen = true;
		}
		svg += `<path d="${d}" fill="none" stroke="${CONFORM_COLORS[k % CONFORM_COLORS.length]}" stroke-width="1.2"/>`;
	});
	svg += ln(ML, MT, ML, H - MB, '#94a3b8', 0.8) + ln(ML, H - MB, W - MR, H - MB, '#94a3b8', 0.8);
	for (const v of yAxis.ticks) {
		svg += ln(ML - 4, sy(v), ML, sy(v), '#94a3b8', 0.8);
		svg += `<text x="${ML - 6}" y="${(sy(v) + 2.2).toFixed(1)}" text-anchor="end" class="fp-tick">${esc(tickLabel(v, yAxis.step))}</text>`;
	}
	for (const v of xAxis.ticks) {
		svg += ln(sx(v), H - MB, sx(v), H - MB + 4, '#94a3b8', 0.8);
		svg += `<text x="${sx(v).toFixed(1)}" y="${H - MB + 12}" text-anchor="middle" class="fp-tick">${esc(tickLabel(v, xAxis.step))}</text>`;
	}
	// the unit alone above the y axis (the tile's title names the quantity, as on the FAST tiles), the x axis titled with its unit
	if (yUnit) svg += `<text x="${ML}" y="${MT - 4}" text-anchor="middle" class="fp-axis">${esc(yUnit)}</text>`;
	svg += `<text x="${((ML + W - MR) / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" class="fp-axis">Time since log start (min)</text>`;
	return `${svg}</svg>`;
}

/** Seconds as a length of time: "12 min 05 s" under an hour, "1 h 23 min" from an hour; an em dash for no reading (numeric strings count). */
export function fmtDuration(s) {
	return formatDuration(typeof s === 'string' && s.trim() !== '' ? Number(s) : s);
}
/** A step figure by the nice-number rule, an em dash for no reading. */
const nn = (v) => niceNumber(typeof v === 'number' ? v : NaN) ?? DASH;
/** A number to `places` decimals (energy), an em dash for no reading. */
const fx = (v, places = 2) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(places) : DASH);

// The words for the parts of the energy a log cannot give (the keys of summary.missing), never the raw keys.
const MISSING_WORDS = { motor: 'motor', ips: 'IPS', cooling: 'cooling' };

function conformSummaryTable(sm) {
	const e = sm.energy_kwh || {};
	const missing = Array.isArray(sm.missing) ? sm.missing : [];
	const rows = [
		['duration_s', sm.duration_s],
		['extruding_s', sm.extruding_s],
		['mean_wheel_speed_rpm', sm.mean_wheel_speed_rpm],
		['mean_torque_pct', sm.mean_torque_pct],
		['mean_tooling1_c', sm.mean_tooling1_c],
		['peak_torque_pct', sm.peak_torque_pct],
		['peak_motor_current_a', sm.peak_motor_current_a],
		['peak_tooling1_c', sm.peak_tooling1_c],
		['peak_wheel_temp_c', sm.peak_wheel_temp_c],
		['ips_setpoint_c', sm.ips_setpoint_c],
		['energy_motor', e.motor],
		['energy_ips', e.ips],
		['energy_cooling', e.cooling],
		['energy_total', e.total],
		['avg_demand_kw', sm.avg_demand_kw],
	].map(([key, v]) => [CONFORM_FIGURES[key].label, formatFigure(key, v)]);
	return `<table class="tbl cf-sum"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join('')}</tbody></table>${
		missing.length ? `<p class="cf-note">Not measured: ${missing.map((m) => esc(MISSING_WORDS[m] ?? m)).join(', ')}. Energy excludes these.</p>` : ''
	}`;
}

function conformStepsTable(steps) {
	const list = Array.isArray(steps) ? steps : [];
	if (!list.length) return '<p class="cf-note">No step of a minute or more at one IPS setpoint and wheel speed in this window.</p>';
	// A range column appears only when some step has that channel.
	const rangeCols = [['wheel_temp_c', 'Wheel temp'], ['tooling1_c', 'Tooling 1'], ['tooling2_c', 'Tooling 2']].filter(([k]) => list.some((s) => s[k]));
	const range = (r) => (r ? `${nn(r.min)}–${nn(r.max)} (${nn(r.range)})` : DASH);
	const head = ['Start', 'End', 'Duration', 'IPS °C', 'Wheel rpm', ...rangeCols.map(([, l]) => `${l} °C min–max (range)`), 'Mean torque %', 'Energy kWh'];
	const numFrom = 3; // the first three columns are text
	const th = head.map((h, i) => `<th${i >= numFrom ? ' class="n"' : ''}>${esc(h)}</th>`).join('');
	const body = list.map((s) => {
		const cells = [
			ukTime(s.start), ukTime(s.end), fmtDuration(s.duration_s), nn(s.ips_setpoint_c), nn(s.wheel_speed_rpm),
			...rangeCols.map(([k]) => range(s[k])), nn(s.mean_torque_pct), fx(s.energy_kwh, 2),
		];
		return `<tr>${cells.map((c, i) => `<td${i >= numFrom ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`;
	}).join('');
	return `<table class="tbl cf-steps"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

// The Conform trace appendix. `run` is the conform_run_data row, `log` the conform_logs
// row and `trace` the parsed CSV ({time, cols}). `loadError` says why there is no trace:
// 'forbidden' (a 403 on the log row or its file) or 'failed' (anything else). Left out
// (null), it is worked out: no `log` is 'forbidden' (the read of the row came back empty
// for the caller), a log without a `trace` is 'failed'. Returns {toggles, blocks}, both ''
// unless the run is 'done'.
export function conformAppendix(run, log, trace, loadError = null) {
	if (!run || run.status !== 'done') return { toggles: '', blocks: '' };
	const logStartMs = Date.parse(log?.log_start);
	const startMs = Date.parse(run.window_start);
	const endMs = Date.parse(run.window_end);

	const why = loadError ?? (log ? (trace ? null : 'failed') : 'forbidden');
	let panels = '';
	let note = '';
	if (why === 'forbidden') {
		note = CONFORM_LOG_HIDDEN;
	} else if (why || !trace?.time?.length || !Number.isFinite(logStartMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		note = CONFORM_LOG_FAILED;
	} else {
		const [from, to] = conformWindowRows(trace.time, logStartMs, startMs, endMs);
		const meta = {};
		for (const c of Array.isArray(log.series) ? log.series : []) meta[c.key] = c;
		if (to - from < 2) {
			note = CONFORM_WINDOW_SHORT;
		} else {
			panels = CONFORM_PANELS.map((p) => {
				const lines = p.keys
					.filter((k) => trace.cols?.[k])
					.map((k) => ({ values: trace.cols[k], label: meta[k]?.label || CONFORM_DEFAULT_LABEL[k] || k, unit: meta[k]?.unit || '' }));
				if (!lines.length) return '';
				const legend = lines.map((l, i) => `<span><i style="background:${CONFORM_COLORS[i % CONFORM_COLORS.length]}"></i>${esc(l.label)}${l.unit ? ` ${esc(l.unit)}` : ''}</span>`).join('');
				return `<div class="fp-plot" data-rows="${to - from}"><div class="fp-title">${esc(p.title)}</div>${conformPanelSvg(lines, trace.time, logStartMs, from, to, lines.find((l) => l.unit)?.unit || '')}<div class="fp-legend">${legend}</div></div>`;
			}).join('');
			if (!panels) note = CONFORM_NO_CHANNELS;
		}
	}
	const plots = panels ? `<div class="cf-plots">${panels}</div>` : `<div class="fp-msg">${esc(note)}</div>`;

	const win = Number.isFinite(startMs) && Number.isFinite(endMs) ? `<p class="cf-window">Run window ${esc(ukDateTime(startMs))} to ${esc(ukTime(endMs))} (UK time)</p>` : '';
	const blocks = `<section data-block="conform-trace">
		<h2>Conform run</h2>
		${win}
		${plots}
		<div class="cf-sub">Summary</div>
		${run.summary ? conformSummaryTable(run.summary) : ''}
		<div class="cf-sub">Steps</div>
		${conformStepsTable(run.steps)}
	</section>`;
	return { toggles: '<label><input type="checkbox" data-block="conform-trace" checked /> Conform run</label>', blocks };
}
