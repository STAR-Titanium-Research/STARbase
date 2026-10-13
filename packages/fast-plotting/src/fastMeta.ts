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

export function buildStats(detail: any, fastRun: any): Stat[] {
	const summary = fastRun?.summary || {};
	const out: Stat[] = [];
	for (const d of STAT_DEFS) {
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

// Data-quality stoplight for an operation row. `fast_run` is the o2m array from the list
// query (status + n_rows). Green = full trace, Yellow = short/partial, Blue = importing,
// Red = none or failed.
export type Quality = 'green' | 'yellow' | 'blue' | 'red';
const SHORT_RUN_ROWS = 100;   // below this a trace is an aborted/partial run

export function dataQuality(op: any): { level: Quality; label: string } {
	const fr = Array.isArray(op?.fast_run) ? op.fast_run[0] : null;
	if (!fr) return { level: 'red', label: 'No trace data' };
	if (fr.status === 'done') {
		if ((fr.n_rows ?? 0) >= SHORT_RUN_ROWS) return { level: 'green', label: 'Trace complete' };
		return { level: 'yellow', label: 'Trace short / partial run' };
	}
	if (fr.status === 'pending' || fr.status === 'processing') return { level: 'blue', label: 'Importing…' };
	return { level: 'red', label: fr.status === 'error' ? 'Import failed' : 'No trace data' };
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
