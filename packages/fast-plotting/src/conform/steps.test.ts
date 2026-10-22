import { describe, expect, it } from 'vitest';
import { parseTrace, type Trace } from '../fastCache';
import { fixtureText } from './__fixtures__/load';
import { normaliseLog } from './normalise';
import { parseConformCsv } from './parse';
import { detectSteps, stepsToCsv } from './steps';

const norm = normaliseLog(parseConformCsv(fixtureText));
const trace = parseTrace(norm.csvText, norm.series);
const t0 = Date.parse(norm.logStart);
const t1 = Date.parse(norm.logEnd);

describe('detectSteps on the fixture', () => {
	const steps = detectSteps(trace, t0, t0, t1);

	it('finds three steps and drops the transients', () => {
		expect(steps).toHaveLength(3);
		expect(steps.map((s) => [s.wheel_speed_rpm, s.duration_s])).toEqual([[3, 84], [4, 208], [5, 602]]);
		expect(steps.every((s) => s.ips_setpoint_c === 500)).toBe(true);
		expect(steps[0].start).toBe('2025-01-15T10:00:00.000Z');
		expect(steps[1].start).toBe('2025-01-15T10:01:28.000Z');
		expect(steps[1].end).toBe('2025-01-15T10:04:55.000Z');
	});

	it('summarises a step', () => {
		const s = steps[1];
		expect(s.tooling1_c!.min).toBeCloseTo(312.76, 5);
		expect(s.tooling1_c!.max).toBeCloseTo(342.775, 5);
		expect(s.tooling1_c!.range).toBeCloseTo(342.775 - 312.76, 5);
		expect(s.mean_torque_pct).toBeCloseTo(18.012487, 5);
		expect(s.energy_kwh).toBeCloseTo(1.776252, 5);
		expect(s.wheel_temp_c).not.toBeNull();
		expect(s.tooling2_c).not.toBeNull();
	});

	it('only sees the rows inside the window', () => {
		const sub = detectSteps(trace, t0, Date.parse('2025-01-15T10:04:58Z'), t1 + 1000);
		expect(sub.map((s) => [s.wheel_speed_rpm, s.duration_s])).toEqual([[5, 602]]);
		expect(detectSteps(trace, t0, t0 + 10_000, t0 + 50_000)).toEqual([]);   // 40 rows
	});

	it('has null tooling 2 when the log has no such channel', () => {
		const keep = norm.series.filter((s) => s.key !== 'tooling2_c');
		const idx = norm.series.findIndex((s) => s.key === 'tooling2_c') + 1;
		const csv = norm.csvText.split('\n').map((l) => { const c = l.split(','); c.splice(idx, 1); return c.join(','); }).join('\n');
		const tr = parseTrace(csv, keep);
		const st = detectSteps(tr, t0, t0, t1);
		expect(st).toHaveLength(3);
		expect(st.every((s) => s.tooling2_c === null)).toBe(true);
		expect(st[0].tooling1_c).not.toBeNull();
	});
});

// 250/300/350 degC x 5/8/10 rpm, 120 rows each, with a 30-row blip between the first two steps.
function grid(): Trace {
	const sp: number[] = [];
	const dm: number[] = [];
	const push = (s: number, d: number, rows: number) => { for (let i = 0; i < rows; i++) { sp.push(s); dm.push(d); } };
	let first = true;
	for (const s of [250, 300, 350]) {
		for (const d of [5, 8, 10]) {
			push(s, d, 120);
			if (first) { push(s, 6.5, 30); first = false; }
		}
	}
	const n = sp.length;
	const mk = (key: string, values: number[]) => ({ key, label: key, unit: '', group: 'x', min: null, max: null, values: Float64Array.from(values) });
	const series = { ips_setpoint_c: mk('ips_setpoint_c', sp), wheel_speed_demand_rpm: mk('wheel_speed_demand_rpm', dm) };
	return { time: Float64Array.from({ length: n }, (_, i) => i), n, series, order: Object.keys(series) };
}

describe('detectSteps on a synthetic grid', () => {
	it('gives nine steps in order and ignores the blip', () => {
		const tr = grid();
		const st = detectSteps(tr, 0, 0, tr.n * 1000);
		expect(st.map((s) => [s.ips_setpoint_c, s.wheel_speed_rpm])).toEqual(
			[250, 300, 350].flatMap((s) => [5, 8, 10].map((d) => [s, d])));
		expect(st.every((s) => s.duration_s === 120)).toBe(true);
		expect(st[0].tooling1_c).toBeNull();
		expect(st[0].energy_kwh).toBe(0);
	});

	it('rounds the demand to 0.5 rpm', () => {
		const tr = grid();
		tr.series.wheel_speed_demand_rpm.values.fill(5.2, 0, 120);
		expect(detectSteps(tr, 0, 0, tr.n * 1000)[0].wheel_speed_rpm).toBe(5);
		tr.series.wheel_speed_demand_rpm.values.fill(5.3, 0, 120);
		expect(detectSteps(tr, 0, 0, tr.n * 1000)[0].wheel_speed_rpm).toBe(5.5);
	});

	it('returns nothing without a wheel speed demand channel', () => {
		const tr = grid();
		delete tr.series.wheel_speed_demand_rpm;
		expect(detectSteps(tr, 0, 0, tr.n * 1000)).toEqual([]);
	});
});

describe('stepsToCsv', () => {
	it('writes a header row and one row per step in UK clock time', () => {
		const steps = detectSteps(trace, t0, t0, t1);
		const lines = stepsToCsv(steps).trimEnd().split('\n');
		expect(lines[0].startsWith('Start,End,Duration (s),IPS setpoint (°C),Wheel speed (rpm)')).toBe(true);
		expect(lines).toHaveLength(4);
		expect(lines[1].startsWith('2025-01-15 10:00:00,2025-01-15 10:01:23,84,500,3,')).toBe(true);
		expect(lines[1].split(',')).toHaveLength(lines[0].split(',').length);
	});
});
