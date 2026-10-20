import { describe, expect, it } from 'vitest';
import type { Series, Trace } from './fastCache';
import { cumulativeEnergy, findPhases, runStats, statsCsv } from './fastStats';

// A 45-minute run sampled every 10 s: heating 20 -> 1350 degC over 800 s, hold at 1350 for 600 s,
// then a straight cool-down to 100 degC over 1300 s. Power is 6 kW until the end of the hold.
// The ram moves 8 mm during the heating, at a steady 0.6 mm/min.
const STEP = 10;
function makeTrace(drop: string[] = []): Trace {
	const n = 271;
	const time = Float64Array.from({ length: n }, (_, i) => i * STEP);
	const temp = time.map((t) => (t <= 800 ? 20 + (1330 * t) / 800 : t <= 1400 ? 1350 : Math.max(100, 1350 - (1250 * (t - 1400)) / 1300)));
	const power = time.map((t) => (t <= 1400 ? 6 : 0));
	const travel = time.map((t) => Math.min(8, (t / 60) * 0.6));
	const mk = (key: string, group: string, values: Float64Array): Series => ({ key, label: key, unit: '', group, min: null, max: null, values });
	const all = [mk('pyro_top', 'temp', temp), mk('sps_power', 'power', power), mk('piston_rel', 'position', travel)].filter((s) => !drop.includes(s.key));
	return { time, n, series: Object.fromEntries(all.map((s) => [s.key, s])), order: all.map((s) => s.key) };
}
const tile = (r: ReturnType<typeof runStats>, key: string) => r.tiles.find((t) => t.key === key);
// The energy of the whole run: 6 kW for 1400 s, then the 10 s step down to 0 averages 3 kW.
const KWH = (6 * 1400 + 3 * 10) / 3600;

describe('findPhases', () => {
	it('finds the heating, the hold within 10 degC of the target and the cooling to 200 degC', () => {
		const t = makeTrace();
		const p = findPhases(t.time, t.series.pyro_top.values, 1350)!;
		// the temperature is within 10 degC of 1350 from t = 800 s to 1410 s (1340.4), and below 200 degC from t = 2596 s
		expect(p.heating).toEqual([0, 800]);
		expect(p.hold).toEqual([800, 1410]);
		expect(p.cooling).toEqual([1410, 2600]);
		expect(p.target).toBe(1350);
	});
	it('uses the peak when there is no target, or the target is never reached', () => {
		const t = makeTrace();
		expect(findPhases(t.time, t.series.pyro_top.values)!.target).toBe(1350);
		expect(findPhases(t.time, t.series.pyro_top.values, 1600)!.target).toBe(1350);
	});
	it('ends the cooling with the trace when it never falls below 200 degC', () => {
		const t = makeTrace();
		const p = findPhases(t.time, t.series.pyro_top.values.map((v) => v + 200), 1550)!;
		expect(p.cooling[1]).toBe(2700);
	});
	it('gives nothing for a flat or too short temperature', () => {
		expect(findPhases(Float64Array.of(0, 1), Float64Array.of(0, 0))).toBeNull();
		expect(findPhases(Float64Array.of(0), Float64Array.of(5))).toBeNull();
	});
});

describe('runStats over the whole run', () => {
	const r = runStats(makeTrace(), { target: 1350, massG: 12 });
	it('reports the nine figures', () => {
		expect(r.tiles.map((t) => t.key)).toEqual(['duration', 'over', 'ramp', 'energy', 'poweron', 'holdpower', 'densification', 'shrink', 'pergram']);
	});
	it('run duration and time over 1000 degC', () => {
		expect(tile(r, 'duration')).toMatchObject({ label: 'Run duration', value: '45.0', unit: 'min' });
		// above 1000 degC from t = 590 s (heating) to 1770 s (cooling)
		expect(Number(tile(r, 'over')!.value)).toBeCloseTo(1180 / 60, 1);
	});
	it('mean ramp is the heating slope', () => {
		expect(tile(r, 'ramp')).toMatchObject({ value: '99.8', unit: '°C/min' });
	});
	it('total energy is the integral of the power, power on is while it is above 2 % of the peak, hold power is the mean in the hold', () => {
		expect(tile(r, 'energy')).toMatchObject({ value: KWH.toFixed(2), unit: 'kWh' });
		expect(Number(tile(r, 'poweron')!.value)).toBeCloseTo(1410 / 60, 1);
		// 6 kW for 600 s, then the 10 s step down to 0 that is still within the band
		expect(tile(r, 'holdpower')).toMatchObject({ value: '5.95', unit: 'kW' });
	});
	it('densification is the net ram travel and the shrink rate the fastest move', () => {
		expect(tile(r, 'densification')).toMatchObject({ value: '8.00', unit: 'mm' });
		expect(tile(r, 'shrink')).toMatchObject({ value: '0.60', unit: 'mm/min' });
	});
	it('energy per gram uses the recorded mass', () => {
		expect(tile(r, 'pergram')).toMatchObject({ value: ((KWH * 1000) / 12).toFixed(0), unit: 'Wh/g' });
	});
});

describe('runStats over a window', () => {
	const hold = { start: 800, end: 1400 };
	it('recalculates for the zoomed range and relabels the tiles', () => {
		const r = runStats(makeTrace(), { target: 1350, window: hold });
		expect(tile(r, 'duration')).toMatchObject({ label: 'Window', value: '10.0' });
		expect(tile(r, 'energy')).toMatchObject({ label: 'Energy', value: '1.00' });
		expect(tile(r, 'holdpower')!.value).toBe('6.00');
		// the ram has stopped by then, and the window holds none of the heating
		expect(tile(r, 'densification')!.value).toBe('0.00');
		expect(tile(r, 'ramp')).toBeUndefined();
	});
	it('keeps the phases of the whole run', () => {
		expect(runStats(makeTrace(), { target: 1350, window: hold }).phases!.hold).toEqual([800, 1410]);
	});
	it('treats a window that reaches past the trace as the whole run', () => {
		const r = runStats(makeTrace(), { window: { start: -50, end: 99999 } });
		expect(tile(r, 'duration')!.label).toBe('Run duration');
	});
});

describe('runStats with series missing', () => {
	it('omits the power figures without a power series', () => {
		const r = runStats(makeTrace(['sps_power']), { massG: 12 });
		expect(r.tiles.map((t) => t.key)).toEqual(['duration', 'over', 'ramp', 'densification', 'shrink']);
	});
	it('omits the temperature figures and the phases without a temperature series', () => {
		const r = runStats(makeTrace(['pyro_top']));
		expect(r.phases).toBeNull();
		expect(r.tiles.map((t) => t.key)).toEqual(['duration', 'energy', 'poweron', 'densification', 'shrink']);
	});
	it('omits the ram figures without a travel series, and the per-gram figure without a mass', () => {
		const r = runStats(makeTrace(['piston_rel']));
		expect(r.tiles.map((t) => t.key)).toEqual(['duration', 'over', 'ramp', 'energy', 'poweron', 'holdpower']);
	});
	it('has no figures for a trace without samples', () => {
		expect(runStats({ time: new Float64Array(0), n: 0, series: {}, order: [] })).toEqual({ phases: null, tiles: [] });
	});
});

describe('statsCsv', () => {
	it('lists the scope, the phase durations and the tiles', () => {
		const csv = statsCsv(runStats(makeTrace(), { target: 1350 }), 'Whole run').split('\r\n');
		expect(csv.slice(0, 6)).toEqual(['Figure,Value,Unit', 'Scope,Whole run,', 'Heating duration,13.3,min', 'Hold duration,10.2,min', 'Cooling duration,19.8,min', 'Run duration,45.0,min']);
		expect(csv[csv.length - 1]).toBe('');
	});
	it('quotes a cell with a comma or a quote', () => {
		expect(statsCsv({ phases: null, tiles: [] }, 'a, "b"')).toContain('Scope,"a, ""b""",');
	});
});

describe('cumulativeEnergy', () => {
	it('integrates the power to kWh and is thinned to the requested number of points', () => {
		const c = cumulativeEnergy(makeTrace(), 50)!;
		expect(c.t.length).toBeLessThanOrEqual(55);
		expect(c.t[c.t.length - 1]).toBe(2700);
		expect(c.kwh[0]).toBe(0);
		expect(c.kwh[c.kwh.length - 1]).toBeCloseTo(KWH, 3);
	});
	it('is absent without a power series', () => {
		expect(cumulativeEnergy(makeTrace(['sps_power']))).toBeNull();
	});
});
