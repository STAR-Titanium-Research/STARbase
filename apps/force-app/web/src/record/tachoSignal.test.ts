import { describe, expect, it } from 'vitest';
import type { Cache } from '@d1/force-plotting';
import { axisLabel, cacheTachoKind, channelLabel, finishedPlotModel, hasMeasuredRpm, tachoMissingNote } from './tachoSignal';

function cacheWith(rpm: number[]): Cache {
	const n = rpm.length;
	const f = (v: number) => new Float32Array(n).fill(v);
	return {
		N: n, Fs: 100, feed: 0.1, diam: 80, csSec: 0, ceSec: n / 100,
		t: Float32Array.from({ length: n }, (_, i) => i / 100), Fx: f(1), Fy: f(2), Fz: f(3),
		rpm: Float32Array.from(rpm), revs: f(0),
	};
}

describe('hasMeasuredRpm / cacheTachoKind', () => {
	it('is true when the rpm series has a real, non-zero sample', () => {
		expect(hasMeasuredRpm(cacheWith([0, 0, 600, 600]))).toBe(true);
		expect(cacheTachoKind(cacheWith([600, 600]))).toBe('rpm');
	});
	it('is false for an all-zero rpm series: finalize writes zeros when the tacho was not measured', () => {
		expect(hasMeasuredRpm(cacheWith([0, 0, 0, 0]))).toBe(false);
		expect(cacheTachoKind(cacheWith([0, 0, 0]))).toBe('none');
	});
	it('ignores NaN and treats a missing or empty series as no tacho', () => {
		expect(hasMeasuredRpm(cacheWith([NaN, NaN]))).toBe(false);
		expect(hasMeasuredRpm(cacheWith([]))).toBe(false);
		expect(hasMeasuredRpm({} as unknown as Cache)).toBe(false);
	});
});

describe('finishedPlotModel', () => {
	it('draws the cache rpm for Tacho: the default bottom panel after a cut finishes', () => {
		const c = cacheWith([600, 610, 620]);
		const m = finishedPlotModel(c, ['Tacho']);
		expect(m.force).toEqual([]);
		expect(m.rpm).toBe(c.rpm);
		expect(m.notes).toEqual([]);
	});
	it('puts force on one axis and RPM on the other when both are selected', () => {
		const c = cacheWith([600, 600]);
		const m = finishedPlotModel(c, ['Fx', 'Fz', 'Tacho']);
		expect(m.force.map(([k]) => k)).toEqual(['Fx', 'Fz']);
		expect(m.rpm).toBe(c.rpm);
	});
	it('says so, and draws nothing, when the cache has no tacho', () => {
		const m = finishedPlotModel(cacheWith([0, 0, 0]), ['Tacho']);
		expect(m.rpm).toBeNull();
		expect(m.force).toEqual([]);
		expect(m.notes).toEqual(['No tacho signal in this recording']);
	});
	it('still draws the force channels next to a missing tacho, with the note', () => {
		const m = finishedPlotModel(cacheWith([0, 0]), ['Fy', 'Tacho']);
		expect(m.force.map(([k]) => k)).toEqual(['Fy']);
		expect(m.notes).toHaveLength(1);
	});
	it('names per-sensor channels the cache cannot hold instead of silently dropping them', () => {
		const m = finishedPlotModel(cacheWith([600, 600]), ['Fx', 'Fx1', 'Fz3']);
		expect(m.force.map(([k]) => k)).toEqual(['Fx']);
		expect(m.notes[0]).toContain('Fx1, Fz3');
	});
});

describe('labels', () => {
	it('titles the Tacho axis by what the channel holds', () => {
		expect(axisLabel(['Tacho'], 'signal')).toBe('Tacho (V)');
		expect(axisLabel(['Tacho'], 'rpm')).toBe('RPM');
		expect(axisLabel(['Tacho'], 'none')).toBe('Tacho');
		expect(axisLabel(['Fx', 'Fy'], 'signal')).toBe('Force (N)');
		expect(axisLabel(['Fx', 'Tacho'], 'rpm')).toBe('Force (N) / RPM');
	});
	it('labels only the Tacho legend entry', () => {
		expect(channelLabel('Tacho', 'rpm')).toBe('Tacho (RPM)');
		expect(channelLabel('Tacho', 'signal')).toBe('Tacho (V)');
		expect(channelLabel('Fx', 'rpm')).toBe('Fx');
	});
	it('has a missing-tacho note only when Tacho is selected and absent or unreadable', () => {
		expect(tachoMissingNote(['Tacho'], 'none')).toBe('No tacho signal in this recording');
		expect(tachoMissingNote(['Fx'], 'none')).toBeNull();
		expect(tachoMissingNote(['Tacho'], 'rpm')).toBeNull();
		expect(tachoMissingNote(['Tacho'], 'signal', null)).toBeNull();
		expect(tachoMissingNote(['Tacho'], 'signal', true)).toBeNull();
		expect(tachoMissingNote(['Tacho'], 'signal', false)).toBe('No readable tacho pulses');
	});
});
