// The Conform profile: Conform runs (process_category = conform) plotted from their log, a shared file with one
// window per run. Data access is the pure/axios helpers of ../conform; this file only shapes it for the plotter.
import type { AxiosInstance } from 'axios';
import {
	CONFORM_FIGURES, CONFORM_STATUS, ConformLogError, LOG_LOAD_FAILED, candidateLabel, candidatesEmptyText, figureNumber, formatClockRange,
	formatUkDate, formatUkDateTimeDisplay, labelWindows, linkExistingLog, listCandidateLogs, loadConformRun, loadLogTrace, setRunWindow,
	unlinkLog, uploadConformLog, windowLine, wholeLogNote, DASH,
	type ConformFigureKey, type ConformLogRow, type ConformRunBundle, type ConformStatus, type ConformSummary,
} from '../conform';
import type { DetailRow, MetaRow, Stat } from '../fastMeta';
import type { RunProfile, RunQuality, RunWindowBand, SummaryTile } from '../profile';

const bundle = (run: unknown): ConformRunBundle | null => (run as ConformRunBundle | null) ?? null;
const summaryOf = (run: unknown): ConformSummary | null => bundle(run)?.run?.summary ?? null;

const fmt = (v: number | string | null | undefined, dp = 1): string | null => {
	if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
	return Number(v).toFixed(dp).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};
const PART_NAME: Record<string, string> = { motor: 'motor', ips: 'IPS', cooling: 'wheel cooling' };

/** The key figures shown with the run's identity (four tiles, 2 by 2): the labels of `CONFORM_FIGURES`. */
const PEAK_KEYS = ['extruding_s', 'mean_torque_pct', 'peak_tooling1_c', 'energy_total'] as const satisfies readonly ConformFigureKey[];
export const CONFORM_PEAK_LABELS: string[] = PEAK_KEYS.map((k) => CONFORM_FIGURES[k].label);

// The worded status of a run, one table for every surface: CONFORM_STATUS (the badge kit's tones as the plotter's colour levels).
const LEVEL = { neutral: 'grey', warning: 'yellow', success: 'green', danger: 'red' } as const;
const STATUS_QUALITY = Object.fromEntries(
	(Object.keys(CONFORM_STATUS) as ConformStatus[]).map((k) => [k, { level: LEVEL[CONFORM_STATUS[k].tone], label: CONFORM_STATUS[k].label, hint: CONFORM_STATUS[k].hint } satisfies RunQuality]),
) as Record<ConformStatus, RunQuality>;
const qualityOfStatus = (status: string | null | undefined): RunQuality => STATUS_QUALITY[(status ?? 'no_log') as ConformStatus] ?? STATUS_QUALITY.no_log;

/** A summary figure as a tile: its number (an em dash with no unit for no reading) and unit. */
function figure(key: ConformFigureKey, value: number | null | undefined): { label: string; value: string; unit: string } {
	const f = CONFORM_FIGURES[key];
	const n = figureNumber(key, value);
	return { label: f.label, value: n ?? DASH, unit: n === null ? '' : f.unit };
}

const IN_HEADER = ['Sample', 'Date', 'Operator', 'Machine', 'Material', 'Feedstock'];

function opRows(op: any): Array<[string, any]> {
	const feedstock = [op?.conform_feedstock, op?.conform_feedstock_form].filter((v) => v && String(v).trim()).join(' · ');
	return [
		['Sample', op?.sample_id?.sample_code],
		['Date', op?.operation_date ? formatUkDateTimeDisplay(op.operation_date) : null],
		['Operator', op?.operator_name],
		['Machine', op?.equipment_id?.equipment_name],
		['Material', op?.material_id?.common_name],
		['Feedstock', feedstock],
		['Run number', op?.conform_run_number],
		['Die exit', fmt(op?.conform_die_diameter_mm, 3) ? `${fmt(op.conform_die_diameter_mm, 3)} mm` : null],
		['Tooling', op?.conform_tooling_id],
		['Wheel speed setpoint', fmt(op?.conform_wheel_speed_rpm, 3) ? `${fmt(op.conform_wheel_speed_rpm, 3)} rpm` : null],
		['IPS setpoint', fmt(op?.conform_ips_setpoint_c, 1) ? `${fmt(op.conform_ips_setpoint_c, 1)} °C` : null],
	];
}
const present = (rows: Array<[string, any]>): MetaRow[] =>
	rows.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([k, v]) => [k, String(v)] as MetaRow);

/** A seconds-from-log-start time as an ISO instant, kept inside the log. */
const isoAt = (log: ConformLogRow, s: number): string => new Date(Date.parse(log.log_start) + s * 1000).toISOString();

export const conformProfile: RunProfile = {
	key: 'conform',
	title: 'Conform plotter',
	heading: 'Conform plotter',
	timeAxisTitle: 'Time since log start (min)',
	peaksTitle: 'Key figures',
	runNoun: 'Conform runs',
	searchPlaceholder: 'Search code / feedstock',
	searchLabel: 'Search runs by code or feedstock',
	layoutKey: 'd1-conform-dashboard-v1',
	listQuery: {
		category: 'conform',
		fields: ['operation_id', 'pass_code', 'operation_date', 'operator_name',
			'conform_run_number', 'conform_feedstock', 'conform_die_diameter_mm', 'conform_wheel_speed_rpm', 'conform_ips_setpoint_c',
			'sample_id.sample_code', 'sample_id.nickname', 'material_id.common_name', 'equipment_id.equipment_name',
			'conform_run.status'],
	},
	detailFields: ['*', 'equipment_id.equipment_id', 'equipment_id.equipment_name', 'method_id.method_name',
		'material_id.common_name', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.sample_id'],
	seedGroups: ['speed', 'torque', 'temp', 'ips', 'power'],
	seedSeries: {
		speed: ['wheel_speed_rpm', 'wheel_speed_demand_rpm'],
		torque: ['motor_torque_pct', 'motor_current_a'],
		temp: ['tooling1_c', 'tooling2_c', 'wheel_temp_c', 'ips_control_c'],
		ips: ['ips_output_pct', 'ips_coil_va'],
		power: ['p_motor_kw', 'p_ips_kw', 'p_cooling_kw', 'p_total_kw'],
	},
	seedStrict: true,
	tabs: ['stats', 'detail'],

	quality: (row) => qualityOfStatus(Array.isArray(row?.conform_run) ? row.conform_run[0]?.status : null),
	listMeta: (r) => [
		r.conform_feedstock || '',
		fmt(r.conform_die_diameter_mm, 3) ? `Ø${fmt(r.conform_die_diameter_mm, 3)} mm` : '',
		fmt(r.conform_wheel_speed_rpm, 3) ? `${fmt(r.conform_wheel_speed_rpm, 3)} rpm` : '',
		fmt(r.conform_ips_setpoint_c, 1) ? `${fmt(r.conform_ips_setpoint_c, 1)} °C` : '',
	].filter(Boolean),

	loadRun: (api, operationId) => loadConformRun(api, operationId),
	async loadTrace(api, run) {
		const b = bundle(run);
		return b?.log && !b.logHidden ? loadLogTrace(api, b.log) : null;
	},
	seriesOf: (run) => bundle(run)?.log?.series ?? [],
	buildOpMeta: (op) => present(opRows(op)),
	buildStats(_op, run): Stat[] {
		const s = summaryOf(run);
		if (!s) return [];
		const value: Record<(typeof PEAK_KEYS)[number], number | null | undefined> = {
			extruding_s: s.extruding_s, mean_torque_pct: s.mean_torque_pct, peak_tooling1_c: s.peak_tooling1_c, energy_total: s.energy_kwh?.total,
		};
		return PEAK_KEYS.map((k) => ({ ...figure(k, value[k]), source: 'measured' as const }));
	},
	peakLabels: CONFORM_PEAK_LABELS,
	factLabels: [],
	peaksNote: 'over the run window',
	headerFacts(op) {
		const rows = opRows(op);
		const get = (k: string) => String(rows.find(([l]) => l === k)?.[1] ?? '');
		const d = op?.operation_date ? formatUkDateTimeDisplay(op.operation_date) : '';
		return [['Date', d], ['Machine', get('Machine')], ['Operator', get('Operator')], ['Feedstock', get('Feedstock')]];
	},
	detailRows(op, run): DetailRow[] {
		const rows: DetailRow[] = present(opRows(op).filter(([k]) => !IN_HEADER.includes(k))).map(([label, value]) => ({ label, value }));
		const b = bundle(run);
		if (b?.log) {
			rows.push({ label: 'Log file', value: b.log.source_filename, tag: 'log' });
			rows.push({ label: 'Log starts', value: `${formatUkDateTimeDisplay(b.log.log_start)} (UK time)`, tag: 'log' });
			rows.push({ label: 'Log rows', value: `${b.log.n_rows.toLocaleString('en-GB')} rows, every 1 s`, tag: 'log' });
		}
		return rows;
	},
	plotMessage(run, _now) {
		const b = bundle(run);
		if (b?.logHidden) return 'Conform log not visible to you';
		if (b?.run?.status === 'error') return `Processing failed: ${b.run.error_message || 'unknown error'}`;
		return b?.log ? 'No trace to plot.' : 'No Conform log has been uploaded for this run.';
	},
	noTraceMessage(run) {
		const b = bundle(run);
		if (b?.logHidden) return 'Conform log not visible to you';
		return b?.run?.status === 'error' ? 'Processing the log failed.' : 'No Conform log has been uploaded for this run.';
	},
	traceReady: (run) => !!bundle(run)?.log,

	summaryTiles(_op, run): SummaryTile[] {
		const s = summaryOf(run);
		if (!s) return [];
		const e = s.energy_kwh;
		// every figure of CONFORM_FIGURES, in reading order; one with no reading is an em dash with no unit
		const tiles: Array<[string, ConformFigureKey, number | null | undefined]> = [
			['duration', 'duration_s', s.duration_s], ['extruding', 'extruding_s', s.extruding_s],
			['speed', 'mean_wheel_speed_rpm', s.mean_wheel_speed_rpm], ['torque', 'mean_torque_pct', s.mean_torque_pct],
			['peakTorque', 'peak_torque_pct', s.peak_torque_pct], ['current', 'peak_motor_current_a', s.peak_motor_current_a],
			['tooling', 'peak_tooling1_c', s.peak_tooling1_c], ['meanTooling', 'mean_tooling1_c', s.mean_tooling1_c],
			['wheelTemp', 'peak_wheel_temp_c', s.peak_wheel_temp_c], ['ips', 'ips_setpoint_c', s.ips_setpoint_c],
			['eMotor', 'energy_motor', e?.motor], ['eIps', 'energy_ips', e?.ips], ['eCooling', 'energy_cooling', e?.cooling],
			['energy', 'energy_total', e?.total], ['demand', 'avg_demand_kw', s.avg_demand_kw],
		];
		return tiles.map(([key, fig, value]) => ({ key, ...figure(fig, value) }));
	},
	summaryNote(run) {
		const s = summaryOf(run);
		if (!s) return null;
		const parts: string[] = [];
		if (s.missing?.length) parts.push(`Not in this log: ${s.missing.map((m) => PART_NAME[m] ?? m).join(', ')} (their energy is left out).`);
		if (s.gaps) parts.push(`${s.gaps} gap${s.gaps === 1 ? '' : 's'} in the 1 s sampling.`);
		return parts.join(' ') || null;
	},
	hasLog: (run) => !!bundle(run)?.log || !!bundle(run)?.logHidden,
	windowLabel(run) {
		const r = bundle(run)?.run;
		if (!r?.window_start || !r.window_end) return null;
		return `${formatClockRange(r.window_start, r.window_end)} on ${formatUkDate(r.window_start)} (UK time)`;
	},
	async upload(api, op, file) {
		const res = await uploadConformLog(api,
			{ operation_id: op.operation_id, equipment_id: op.equipment_id?.equipment_id ?? null, operation_date: op.operation_date ?? null, work_state: op.work_state ?? null },
			{ name: file.name, bytes: await file.arrayBuffer() });
		if ('existing' in res) {
			return { warning: null, existing: { id: res.existing.log_id, label: candidateLabel(res.existing), windows: res.existingWindows.map(windowLine), note: wholeLogNote(res.existing, res.existingWindows) } };
		}
		return { warning: res.dateWarning };
	},
	async unlink(api, op) { await unlinkLog(api, op.operation_id); },
	traceErrorMessage: (e) => (e instanceof ConformLogError ? e.message : LOG_LOAD_FAILED),
	startMs(run) {
		const t = bundle(run)?.log?.log_start;
		const ms = t ? Date.parse(t) : NaN;
		return Number.isNaN(ms) ? null : ms;
	},
	async windows(api, run): Promise<RunWindowBand[]> {
		const b = bundle(run);
		if (!b?.log) return [];
		const t0 = Date.parse(b.log.log_start);
		const rows = await labelWindows(api, b.log.run_windows);
		return rows.map((w) => ({
			operationId: w.operation_id,
			label: w.label,
			startS: (Date.parse(w.start) - t0) / 1000,
			endS: (Date.parse(w.end) - t0) / 1000,
			current: w.operation_id === b.run?.operation_id,
		}));
	},
	async setWindowFromView(api, op, run, startS, endS) {
		const log = bundle(run)?.log;
		if (!log) throw new ConformLogError('This run has no Conform log yet.');
		const s = Math.max(0, Math.round(startS));
		const e = Math.min(log.duration_s, Math.round(endS));
		await setRunWindow(api, op.operation_id, isoAt(log, s), isoAt(log, e));
	},
	linkExisting: {
		async list(api: AxiosInstance, op) {
			const logs = await listCandidateLogs(api, op?.equipment_id?.equipment_id ?? null, op?.operation_date ?? null);
			return logs.map((l) => ({ id: l.log_id, label: candidateLabel(l), windows: l.windows.map(windowLine), note: wholeLogNote(l, l.windows) }));
		},
		emptyText: (op) => candidatesEmptyText(op?.operation_date ?? null),
		async link(api, op, id) { await linkExistingLog(api, op.operation_id, id); },
	},
	runQuality: (run) => (bundle(run)?.run ? qualityOfStatus(bundle(run)!.run!.status) : qualityOfStatus('no_log')),
};
