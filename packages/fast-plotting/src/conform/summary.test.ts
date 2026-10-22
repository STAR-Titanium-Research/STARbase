import { describe, expect, it } from 'vitest';
import { parseTrace, type Trace } from '../fastCache';
import { fixtureText } from './__fixtures__/load';
import { formatUkDateTime, formatUkTime } from './clock';
import { normaliseLog } from './normalise';
import { parseConformCsv } from './parse';
import { summariseWindow, windowRows } from './summary';

const norm = normaliseLog(parseConformCsv(fixtureText));
const trace = parseTrace(norm.csvText, norm.series);
const t0 = Date.parse(norm.logStart);
const t1 = Date.parse(norm.logEnd);

describe('windowRows', () => {
	it('is half open, but takes the last row when the window ends at the log end', () => {
		expect(windowRows(trace, t0, t0, t1)).toEqual([0, 900]);
		expect(windowRows(trace, t0, t0, t1 + 1000)).toEqual([0, 900]);
		expect(windowRows(trace, t0, t0 + 10_000, t0 + 20_000)).toEqual([10, 20]);
		expect(windowRows(trace, t0, t0 - 50_000, t0 + 5_000)).toEqual([0, 5]);
		expect(windowRows(trace, t0, t0 + 20_000, t0 + 20_000)).toEqual([20, 20]);
	});
});

describe('summariseWindow', () => {
	const s = summariseWindow(trace, t0, t0, t1);

	it('summarises the whole fixture', () => {
		expect(s.version).toBe(1);
		expect(s.extruding_s).toBe(870);
		expect(s.mean_wheel_speed_rpm).toBeCloseTo(4.628926, 5);
		expect(s.mean_torque_pct).toBeCloseTo(17.904279, 5);
		expect(s.mean_tooling1_c).toBeCloseTo(367.3525, 5);
		expect(s.peak_torque_pct).toBeCloseTo(22.0, 5);
		expect(s.peak_motor_current_a).toBeCloseTo(51.4, 5);
		expect(s.peak_tooling1_c).toBeCloseTo(430.355, 5);
		expect(s.peak_wheel_temp_c).toBeCloseTo(96.93, 5);
		expect(s.energy_kwh.total).toBeCloseTo(7.523869, 5);
		expect(s.duration_s).toBe(899);
		expect(s.n_rows).toBe(900);
		expect(s.gaps).toBe(0);
		expect(s.ips_setpoint_c).toBe(500);
		expect(s.missing).toEqual([]);
	});

	it('summarises a sub-window, clipped to the log', () => {
		const sub = summariseWindow(trace, t0, Date.parse('2025-01-15T10:04:58Z'), Date.parse('2025-01-15T10:15:00Z'));
		expect(sub.energy_kwh.total).toBeCloseTo(5.118654, 5);
		expect(sub.n_rows).toBe(602);
	});

	it('does not throw on an empty window or a log without the optional channels', () => {
		const e = summariseWindow(trace, t0, t1 + 5000, t1 + 9000);
		expect(e.n_rows).toBe(0);
		expect(e.duration_s).toBe(0);
		expect(e.extruding_s).toBe(0);
		expect(e.peak_torque_pct).toBeNull();
		expect(e.ips_setpoint_c).toBeNull();
		expect(e.energy_kwh.total).toBe(0);

		const parsed = parseConformCsv(['Timestamp,Wheel Speed (rpm),Motor Current (A)',
			'2025-03-17T13:38:20Z,5,10', '2025-03-17T13:38:21Z,5,10'].join('\n'));
		const n = normaliseLog(parsed);
		const sm = summariseWindow(parseTrace(n.csvText, n.series), Date.parse(n.logStart), Date.parse(n.logStart), Date.parse(n.logEnd));
		expect(sm.missing).toEqual(['ips', 'cooling']);
		expect(sm.mean_torque_pct).toBeNull();
		expect(sm.extruding_s).toBe(0);
		expect(sm.energy_kwh.motor).toBeGreaterThan(0);
		expect(sm.energy_kwh.ips).toBeNull();
	});

	it('counts gaps over 1.5 s inside the window', () => {
		const tr: Trace = { time: Float64Array.from([0, 1, 5, 6]), n: 4, series: {}, order: [] };
		expect(summariseWindow(tr, 0, 0, 10_000).gaps).toBe(1);
	});
});

describe('UK clock', () => {
	it('formats in Europe/London, including summer time', () => {
		expect(formatUkTime('2025-03-17T13:38:20.000Z')).toBe('13:38:20');
		expect(formatUkTime('2025-07-01T12:00:00Z')).toBe('13:00:00');
		expect(formatUkDateTime('2025-07-01T23:30:00Z')).toBe('2025-07-02 00:30:00');
		expect(formatUkTime('nonsense')).toBe('');
	});
});
