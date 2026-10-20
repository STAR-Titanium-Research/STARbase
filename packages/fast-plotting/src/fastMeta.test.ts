import { describe, expect, it } from 'vitest';
import { CYCLE_LABELS, MOULD_LABELS, PEAK_LABELS, buildDetailRows, buildHeader, buildStats, dataQuality } from './fastMeta';

describe('dataQuality', () => {
	const q = (fr: any) => dataQuality({ fast_run: fr ? [fr] : [] });
	it('words each state of the trace', () => {
		expect(q({ status: 'done', n_rows: 5000 })).toMatchObject({ level: 'green', label: 'Trace complete' });
		expect(q({ status: 'done', n_rows: 40 })).toMatchObject({ level: 'yellow', label: 'Short run' });
		expect(q({ status: 'pending' })).toMatchObject({ level: 'blue', label: 'Importing…' });
		expect(q({ status: 'processing' })).toMatchObject({ level: 'blue', label: 'Importing…' });
		expect(q({ status: 'error' })).toMatchObject({ level: 'red', label: 'Import failed' });
		expect(q(null)).toMatchObject({ level: 'grey', label: 'No trace' });
	});
});

describe('buildStats', () => {
	const detail = { sintering_max_temp_celsius: 1340, sintering_mould_diameter_mm: 20, sintering_mass_grams: 12.4 };
	const run = { summary: { peak_temp_c: 1362, peak_force_kn: 30, dwell_s: 600, ramp_c_per_min: 100 } };
	it('gives the peaks that exist, measured first and recorded as the fallback', () => {
		const peaks = buildStats(detail, run, PEAK_LABELS);
		expect(peaks.map((s) => s.label)).toEqual(['Peak temp', 'Peak force']);
		expect(peaks[0]).toMatchObject({ value: '1362', source: 'measured' });
		expect(buildStats(detail, null, PEAK_LABELS)).toEqual([{ label: 'Peak temp', value: '1340', unit: '°C', source: 'recorded' }]);
	});
	it('gives the cycle and the recorded mould figures separately', () => {
		expect(buildStats(detail, run, CYCLE_LABELS).map((s) => `${s.label} ${s.value} ${s.unit}`)).toEqual(['Dwell 10 min', 'Ramp 100 °C/min']);
		expect(buildStats(detail, run, MOULD_LABELS).map((s) => `${s.label} ${s.value} ${s.unit} ${s.source}`)).toEqual(['Mould Ø 20 mm recorded', 'Mass 12.40 g recorded']);
	});
});

describe('buildHeader', () => {
	it('collects the identity of the run, leaving out what is not recorded', () => {
		const h = buildHeader({
			sample_id: { sample_code: 'S-1', sample_id: 'u1', nickname: 'WC-10Co' }, material_id: { common_name: 'Tungsten carbide' },
			operation_date: '2026-10-10T11:12:00Z', equipment_id: { equipment_name: 'FCT HP D 25' }, operator_name: 'K. Johnson',
		});
		expect(h).toMatchObject({ sampleCode: 'S-1', sampleId: 'u1', material: 'Tungsten carbide · WC-10Co', machine: 'FCT HP D 25', operator: 'K. Johnson', atmosphere: '' });
		expect(h.date).toMatch(/2026/);
		expect(buildHeader(null)).toMatchObject({ sampleCode: null, material: '', date: '' });
	});
});

describe('buildDetailRows', () => {
	it('lists what the header does not show, then the measured cycle and the trace', () => {
		const detail = { operator_name: 'K', sintering_batch_number: 'B-1', sintering_coshh_ref: 'CH-1', sintering_atmosphere: 'Vacuum' };
		const run = { status: 'done', n_rows: 1001, duration_s: 1000, updated_at: '2026-10-10T12:02:00Z', summary: { dwell_s: 600 } };
		const rows = buildDetailRows(detail, run);
		expect(rows.map((r) => r.label)).toEqual(['Batch', 'Atmosphere', 'CoSHH', 'Dwell', 'Trace', 'Imported']);
		expect(rows.find((r) => r.label === 'CoSHH')!.tag).toBe('QA log');
		expect(rows.find((r) => r.label === 'Dwell')).toMatchObject({ value: '10 min', tag: 'measured' });
		expect(rows.find((r) => r.label === 'Trace')!.value).toBe('1,001 rows · every 1 s');
	});
	it('has only the record rows without a trace', () => {
		expect(buildDetailRows({ sintering_batch_number: 'B-1' }, null).map((r) => r.label)).toEqual(['Batch']);
	});
});
