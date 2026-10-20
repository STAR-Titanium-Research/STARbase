// Pure metadata/stat derivation for the FAST detail panel, kept out of FastDashboard.vue
// so it stays readable and these rules are testable on their own.
//
// Provenance rule (project-wide): machine data and the measured trace are authoritative for
// every non-QA field. The sheet logs supply ONLY CoSHH ref and comments.

export type Source = 'measured' | 'recorded' | 'QA log';
export interface Stat { label: string; value: string; unit: string; source: Source; }
export type MetaRow = [string, string];

function num(v: any, dp = 1): string | null {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return n.toFixed(dp).replace(/\.0+$/, '');
}

export function buildOpMeta(detail: any): MetaRow[] {
	if (!detail) return [];
	const rows: Array<[string, any]> = [
		['Sample', detail.sample_id?.sample_code],
		['Date', detail.operation_date ? new Date(detail.operation_date).toLocaleString() : null],
		['Operator', detail.operator_name],
		['Machine', detail.equipment_id?.equipment_name],
		['Material', detail.material_id?.common_name || detail.sintering_material_type_note],
		['Recipe', detail.fast_recipe_id?.name || detail.sintering_recipe_number],
		['Batch', detail.sintering_batch_number],
		['Atmosphere', detail.sintering_atmosphere],
		['TC/Pyro', detail.sintering_tc_pyro_control],
		['CoSHH', detail.sintering_coshh_ref],
	];
	return rows
		.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
		.map(([k, v]) => [k, String(v)] as MetaRow);
}

// Human-scaled dwell: seconds under 2 min, minutes up to an hour, hours beyond.
function fmtDwell(s: number): { value: string; unit: string } {
	if (!Number.isFinite(s)) return { value: '—', unit: 's' };
	if (s < 120) return { value: String(Math.round(s)), unit: 's' };
	if (s < 3600) return { value: (s / 60).toFixed(1).replace(/\.0$/, ''), unit: 'min' };
	return { value: (s / 3600).toFixed(2).replace(/\.?0+$/, ''), unit: 'h' };
}

// Each stat: prefer the measured trace summary, else the recorded machine metadata.
// A stat with neither source is omitted entirely rather than rendered empty. `fmt` lets a
// stat scale its own unit (e.g. dwell) instead of using the fixed `unit`/`dp`.
const STAT_DEFS: Array<{
	label: string; unit: string; sum?: string; rec?: string; dp?: number;
	fmt?: (n: number) => { value: string; unit: string };
}> = [
	{ label: 'Peak temp',  unit: '°C', sum: 'peak_temp_c',    rec: 'sintering_max_temp_celsius' },
	{ label: 'Peak force', unit: 'kN', sum: 'peak_force_kn',  rec: 'sintering_max_force_kn' },
	{ label: 'Peak power', unit: 'kW', sum: 'peak_power_kw' },
	{ label: 'Peak volts', unit: 'V',  sum: 'peak_voltage_v' },
	{ label: 'PTC top',    unit: '°C', sum: 'ptc_top_max_c' },
	{ label: 'PTC bot',    unit: '°C', sum: 'ptc_bot_max_c' },
	{ label: 'Dwell',      unit: 's',  sum: 'dwell_s', fmt: fmtDwell },
	{ label: 'Ramp',       unit: '°C/min', sum: 'ramp_c_per_min' },
	{ label: 'Mould Ø',    unit: 'mm', rec: 'sintering_mould_diameter_mm' },
	{ label: 'Mass',       unit: 'g',  rec: 'sintering_mass_grams', dp: 2 },
];

// The six peak tiles of the run column, the measured cycle figures of the Operation detail tab, and the
// two recorded figures that sit with the run's identity.
export const PEAK_LABELS = ['Peak temp', 'Peak force', 'Peak power', 'Peak volts', 'PTC top', 'PTC bot'];
export const CYCLE_LABELS = ['Dwell', 'Ramp'];
export const MOULD_LABELS = ['Mould Ø', 'Mass'];

export function buildStats(detail: any, fastRun: any, only?: string[]): Stat[] {
	const summary = fastRun?.summary || {};
	const out: Stat[] = [];
	for (const d of STAT_DEFS) {
		if (only && !only.includes(d.label)) continue;
		const rawMeasured = d.sum ? summary[d.sum] : undefined;
		if (rawMeasured !== undefined && rawMeasured !== null && Number.isFinite(Number(rawMeasured))) {
			const f = d.fmt ? d.fmt(Number(rawMeasured)) : { value: num(rawMeasured, d.dp ?? 1)!, unit: d.unit };
			out.push({ label: d.label, value: f.value, unit: f.unit, source: 'measured' });
			continue;
		}
		const recorded = d.rec && detail ? num(detail[d.rec], d.dp ?? 1) : null;
		if (recorded !== null) {
			out.push({ label: d.label, value: recorded, unit: d.unit, source: 'recorded' });
		}
	}
	return out;
}

// Data quality of an operation's trace: a word for the badge (`label`), a tone (`level`) and a hint for
// the tooltip. `fast_run` is the o2m array from the list query (status + n_rows). Green = full trace,
// yellow = short/partial, blue = importing, red = import failed, grey = no trace.
export type Quality = 'green' | 'yellow' | 'blue' | 'red' | 'grey';
const SHORT_RUN_ROWS = 100;   // below this a trace is an aborted/partial run

export function dataQuality(op: any): { level: Quality; label: string; hint: string } {
	const fr = Array.isArray(op?.fast_run) ? op.fast_run[0] : null;
	if (!fr) return { level: 'grey', label: 'No trace', hint: 'No trace was imported for this run' };
	if (fr.status === 'done') {
		if ((fr.n_rows ?? 0) >= SHORT_RUN_ROWS) return { level: 'green', label: 'Trace complete', hint: 'The full trace is imported' };
		return { level: 'yellow', label: 'Short run', hint: 'A short trace: an aborted or partial run' };
	}
	if (fr.status === 'pending' || fr.status === 'processing') return { level: 'blue', label: 'Importing…', hint: 'The trace is queued or being imported' };
	if (fr.status === 'error') return { level: 'red', label: 'Import failed', hint: 'The trace import failed' };
	return { level: 'grey', label: 'No trace', hint: 'No trace was imported for this run' };
}

export function buildRecipe(detail: any) {
	const r = detail?.fast_recipe_id;
	if (!r || typeof r !== 'object') return null;
	return {
		id: r.id,
		name: r.name,
		programNr: r.program_nr,
		machine: r.machine,
		group: r.group_name,
		source: r.source_file,
		tempC: num(r.target_temp_c, 0),
		forceKn: num(r.target_force_kn, 1),
		holdMin: num(r.hold_time_min, 0),
		targets: [
			r.target_temp_c ? `${num(r.target_temp_c, 0)} °C` : null,
			r.target_force_kn ? `${num(r.target_force_kn, 1)} kN` : null,
			r.hold_time_min ? `${num(r.hold_time_min, 0)} min` : null,
		].filter(Boolean).join(' · '),
	};
}

export function fmtDateTime(v: string | null | undefined): string {
	if (!v) return '';
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// What the run column always shows above its tabs: the sample, the material, when, on what, by whom.
export interface RunHeader {
	sampleCode: string | null; sampleId: string | null; material: string;
	date: string; machine: string; operator: string; atmosphere: string;
}

export function buildHeader(detail: any): RunHeader {
	const material = [detail?.material_id?.common_name || detail?.sintering_material_type_note, detail?.sample_id?.nickname]
		.filter((v) => v && String(v).trim()).join(' · ');
	return {
		sampleCode: detail?.sample_id?.sample_code ?? null,
		sampleId: detail?.sample_id?.sample_id ?? null,
		material,
		date: fmtDateTime(detail?.operation_date),
		machine: detail?.equipment_id?.equipment_name ?? '',
		operator: detail?.operator_name ?? '',
		atmosphere: detail?.sintering_atmosphere ?? '',
	};
}

// Rows of the Operation detail tab: what the header does not already show (batch, control, CoSHH, ...),
// the measured cycle figures and the trace itself. `tag` says where a value comes from, when it is not
// the operation record.
export interface DetailRow { label: string; value: string; tag?: string; }
const IN_HEADER = ['Sample', 'Date', 'Operator', 'Machine', 'Material'];

export function buildDetailRows(detail: any, fastRun: any): DetailRow[] {
	const rows: DetailRow[] = buildOpMeta(detail)
		.filter(([k]) => !IN_HEADER.includes(k))
		.map(([label, value]) => ({ label, value, ...(label === 'CoSHH' ? { tag: 'QA log' } : {}) }));
	for (const s of buildStats(detail, fastRun, CYCLE_LABELS)) {
		if (s.source === 'measured') rows.push({ label: s.label, value: `${s.value} ${s.unit}`, tag: 'measured' });
	}
	const n = Number(fastRun?.n_rows), dur = Number(fastRun?.duration_s);
	if (Number.isFinite(n) && n > 0) {
		const every = n > 1 && Number.isFinite(dur) && dur > 0 ? ` · every ${+(dur / (n - 1)).toPrecision(2)} s` : '';
		rows.push({ label: 'Trace', value: `${n.toLocaleString('en-GB')} rows${every}` });
	}
	const imported = fmtDateTime(fastRun?.updated_at);
	if (imported && fastRun?.status === 'done') rows.push({ label: 'Imported', value: imported });
	return rows;
}
