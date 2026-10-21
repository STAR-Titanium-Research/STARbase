import { describe, expect, it } from 'vitest';
import { parseTrace } from '../fastCache';
import { fixtureText } from './__fixtures__/load';
import { normaliseLog } from './normalise';
import { parseConformCsv } from './parse';

const parsed = parseConformCsv(fixtureText);
const norm = normaliseLog(parsed);

describe('normaliseLog', () => {
	it('writes time_s first and the series in CSV column order, power channels last', () => {
		const header = norm.csvText.split('\n')[0].split(',');
		expect(header[0]).toBe('time_s');
		expect(header.slice(1)).toEqual(norm.series.map((s) => s.key));
		expect(norm.series.slice(-4).map((s) => s.key)).toEqual(['p_motor_kw', 'p_ips_kw', 'p_cooling_kw', 'p_total_kw']);
		expect(norm.series.slice(-4).every((s) => s.group === 'power' && s.unit === 'kW')).toBe(true);
		expect(norm.series.slice(0, -4).map((s) => s.key)).toEqual(parsed.channels.map((c) => c.key));
	});

	it('round-trips through parseTrace', () => {
		const t = parseTrace(norm.csvText, norm.series);
		expect(t.n).toBe(900);
		expect(t.series.motor_current_a.values[0]).toBe(parsed.values.motor_current_a[0]);
		expect(t.series.motor_current_a.values[899]).toBe(parsed.values.motor_current_a[899]);
		expect(t.time[899]).toBe(899);
		expect(t.series.p_total_kw.values[10]).toBeCloseTo(
			t.series.p_motor_kw.values[10] + t.series.p_ips_kw.values[10] + t.series.p_cooling_kw.values[10], 6);
	});

	it('records min, max and flat channels', () => {
		const t2 = norm.series.find((s) => s.key === 'tooling2_c')!;
		expect(t2.flat).toBe(true);
		expect(t2.min!).toBeGreaterThanOrEqual(23.9);
		expect(t2.max!).toBeLessThanOrEqual(24.4);
		expect(norm.series.find((s) => s.key === 'tooling1_c')!.flat).toBeFalsy();
		expect(norm.series.find((s) => s.key === 'wheel_speed_rpm')!.flat).toBeFalsy();
	});

	it('reports whole-log totals and the log span', () => {
		expect(norm.totals.duration_s).toBe(899);
		expect(norm.totals.energy_kwh.total).toBeCloseTo(7.670553, 5);
		expect(norm.totals.missing).toEqual([]);
		expect(norm.totals.avg_demand_kw).toBeCloseTo((7.670553 * 3600) / 900, 3);
		expect(norm.logStart).toBe('2025-03-17T13:38:20.000Z');
		expect(norm.logEnd).toBe('2025-03-17T13:53:19.000Z');
		expect(norm.nRows).toBe(900);
		expect(norm.durationS).toBe(899);
		expect(norm.constants.version).toBe(1);
	});

	it('still normalises a log without the IPS channels', () => {
		const csv = [
			'Timestamp,Motor Current (A),Wheel Speed (rpm)',
			'2025-03-17T13:38:20Z,10,5',
			'2025-03-17T13:38:21Z,20,5',
		].join('\n');
		const n = normaliseLog(parseConformCsv(csv));
		expect(n.totals.missing).toEqual(['ips', 'cooling']);
		expect(n.totals.energy_kwh.ips).toBeNull();
		expect(n.series.map((s) => s.key)).toEqual(['wheel_speed_rpm', 'motor_current_a', 'p_motor_kw', 'p_total_kw']);
	});
});
