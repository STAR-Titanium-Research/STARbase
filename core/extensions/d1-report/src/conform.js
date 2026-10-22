// The Conform run appendix of the operation datasheet, and the reader of the stored Conform CSV it plots.
// Split out of render.js (review round 1 of docs/superpowers/plans/2026-10-21-conform-runs.md).

import { esc, niceNum } from './util.js';

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
// The formats are the shared ones of the Conform plan (Operation page, plotter, PDF):
// energy in kWh and average demand in kW to 2 decimals, durations as "12 min 05 s"
// under an hour and "1 h 23 min" from an hour, clock times HH:MM:SS in UK time.
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
const UK_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: '2-digit', month: '2-digit', year: 'numeric' });
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
/** HH:MM:SS in UK local time (Europe/London); '' for an invalid instant. */
const ukTime = (t) => { const ms = toMs(t); return Number.isFinite(ms) ? UK_TIME.format(ms) : ''; };
const ukDateTime = (t) => { const ms = toMs(t); return Number.isFinite(ms) ? `${UK_DATE.format(ms)} ${UK_TIME.format(ms)}` : ''; };

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

function conformPanelSvg(lines, time, logStartMs, from, to) {
	const W = 300, H = 148, ML = 36, MR = 6, MT = 8, MB = 15;
	let lo = Infinity, hi = -Infinity;
	for (const l of lines) for (let i = from; i < to; i++) { const v = l.values[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
	if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
	if (lo === hi) { lo -= 1; hi += 1; }
	const t0 = time[from], t1 = time[to - 1];
	const plotW = W - ML - MR, plotH = H - MT - MB;
	const sx = (x) => ML + ((x - t0) / (t1 - t0 || 1)) * plotW;
	const sy = (v) => MT + (1 - (v - lo) / (hi - lo)) * plotH;
	const stride = Math.max(1, Math.floor((to - from) / 400));
	const ln = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="0.7"/>`;
	let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${ln(ML, MT, ML, H - MB)}${ln(ML, H - MB, W - MR, H - MB)}`;
	for (const v of [hi, (lo + hi) / 2, lo]) svg += `<text x="${ML - 3}" y="${(sy(v) + 2).toFixed(1)}" text-anchor="end" class="fp-tick">${esc(niceNum(v))}</text>`;
	[[t0, ML, 'start'], [t1, W - MR, 'end']].forEach(([t, x, anchor]) => {
		svg += `<text x="${x}" y="${H - 3}" text-anchor="${anchor}" class="fp-tick">${esc(ukTime(logStartMs + t * 1000).slice(0, 5))}</text>`;
	});
	lines.forEach((l, k) => {
		let d = '', pen = false;
		for (let i = from; i < to; i += stride) {
			const v = l.values[i];
			if (!Number.isFinite(v)) { pen = false; continue; }
			d += `${pen ? 'L' : 'M'}${sx(time[i]).toFixed(1)},${sy(v).toFixed(1)} `;
			pen = true;
		}
		svg += `<path d="${d}" fill="none" stroke="${CONFORM_COLORS[k % CONFORM_COLORS.length]}" stroke-width="1"/>`;
	});
	return `${svg}</svg>`;
}

/** Seconds as a length of time: "12 min 05 s" under an hour, "1 h 23 min" from an hour (whole seconds first, then minutes cut, not rounded). */
export function fmtDuration(s) {
	if (s === null || s === undefined || s === '' || !Number.isFinite(Number(s)) || Number(s) < 0) return '—';
	const t = Math.round(Number(s));
	if (t < 3600) return `${Math.floor(t / 60)} min ${String(t % 60).padStart(2, '0')} s`;
	return `${Math.floor(t / 3600)} h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')} min`;
}
const fx = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d));

function conformSummaryTable(sm) {
	const e = sm.energy_kwh || {};
	const missing = Array.isArray(sm.missing) ? sm.missing : [];
	const rows = [
		['Duration', fmtDuration(sm.duration_s)],
		['Extruding time', fmtDuration(sm.extruding_s)],
		['Mean wheel speed', `${fx(sm.mean_wheel_speed_rpm)} rpm`],
		['Mean motor torque', `${fx(sm.mean_torque_pct)} %`],
		['Mean Tooling 1 (behind abutment)', `${fx(sm.mean_tooling1_c)} °C`],
		['Peak motor torque', `${fx(sm.peak_torque_pct)} %`],
		['Peak motor current', `${fx(sm.peak_motor_current_a)} A`],
		['Peak Tooling 1 (behind abutment)', `${fx(sm.peak_tooling1_c)} °C`],
		['Peak wheel temperature', `${fx(sm.peak_wheel_temp_c)} °C`],
		['IPS setpoint', `${fx(sm.ips_setpoint_c, 0)} °C`],
		['Energy (motor)', `${fx(e.motor, 2)} kWh`],
		['Energy (IPS)', `${fx(e.ips, 2)} kWh`],
		['Energy (cooling)', `${fx(e.cooling, 2)} kWh`],
		['Energy (total)', `${fx(e.total, 2)} kWh`],
		['Average demand', `${fx(sm.avg_demand_kw, 2)} kW`],
	];
	return `<table class="tbl cf-sum"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join('')}</tbody></table>${
		missing.length ? `<p class="cf-note">Not measured: ${missing.map(esc).join(', ')}. Energy excludes these.</p>` : ''
	}`;
}

function conformStepsTable(steps) {
	const list = Array.isArray(steps) ? steps : [];
	if (!list.length) return '<p class="cf-note">No steps were found in this window.</p>';
	// A range column appears only when some step has that channel.
	const rangeCols = [['wheel_temp_c', 'Wheel temp'], ['tooling1_c', 'Tooling 1'], ['tooling2_c', 'Tooling 2']].filter(([k]) => list.some((s) => s[k]));
	const range = (r) => (r ? `${fx(r.min)}–${fx(r.max)} (${fx(r.range)})` : '—');
	const head = ['Start', 'End', 'Duration', 'IPS °C', 'Wheel rpm', ...rangeCols.map(([, l]) => `${l} °C min–max (range)`), 'Mean torque %', 'Energy kWh'];
	const numFrom = 3; // the first three columns are text
	const th = head.map((h, i) => `<th${i >= numFrom ? ' class="n"' : ''}>${esc(h)}</th>`).join('');
	const body = list.map((s) => {
		const cells = [
			ukTime(s.start), ukTime(s.end), fmtDuration(s.duration_s), fx(s.ips_setpoint_c, 0), fx(s.wheel_speed_rpm),
			...rangeCols.map(([k]) => range(s[k])), fx(s.mean_torque_pct), fx(s.energy_kwh, 2),
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
				return `<div class="fp-plot" data-rows="${to - from}"><div class="fp-title">${esc(p.title)}</div>${conformPanelSvg(lines, trace.time, logStartMs, from, to)}<div class="fp-legend">${legend}</div></div>`;
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
