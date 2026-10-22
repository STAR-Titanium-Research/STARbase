import { describe, expect, it } from 'vitest';
import { expected, fixtureText } from './__fixtures__/load';
import { parseConformCsv } from './parse';
import { CONFORM_POWER_CONSTANTS, energyKwh, powerChannels } from './power';

const p = parseConformCsv(fixtureText);
const get = (omit: string[] = []) => (key: string) => (omit.includes(key) ? undefined : p.values[key]);

describe('power', () => {
	it('has the maintainer constants', () => {
		expect(CONFORM_POWER_CONSTANTS).toEqual({ voltage_v: 400, cos_phi_motor: 0.85, k_ips: 0.95, cos_phi_cooling: 0.8, version: 1 });
	});

	it('computes the kW of one row by the stated formulas', () => {
		const pw = powerChannels(get(), p.n);
		expect(pw.p_motor_kw![0]).toBeCloseTo((Math.sqrt(3) * 400 * 16.2 * 0.85) / 1000, 9);
		expect(pw.p_ips_kw![0]).toBeCloseTo((9600 * 0.95) / 1000, 9);
		expect(pw.p_total_kw[0]).toBeCloseTo(pw.p_motor_kw![0] + pw.p_ips_kw![0] + pw.p_cooling_kw![0], 9);
		expect(pw.missing).toEqual([]);
	});

	it('matches the independent golden energy over the fixture', () => {
		const e = energyKwh(powerChannels(get(), p.n), 0, 900);
		expect(e.motor).toBeCloseTo(6.112229, 5);
		expect(e.ips).toBeCloseTo(1.411225, 5);
		expect(e.cooling).toBeCloseTo(0.000416, 6);
		expect(e.total).toBeCloseTo(7.523869, 5);
		expect(e.motor as number).toBeCloseTo(expected.energy.motor, 9);
		expect(e.total).toBeCloseTo(expected.energy.total, 9);
	});

	it('uses half-open row ranges and clamps them', () => {
		const pw = powerChannels(get(), p.n);
		const all = energyKwh(pw, 0, 900).total;
		const a = energyKwh(pw, 0, 400).total;
		const b = energyKwh(pw, 400, 900).total;
		expect(a + b).toBeCloseTo(all, 9);
		expect(energyKwh(pw, -5, 5000).total).toBeCloseTo(all, 9);
		expect(energyKwh(pw, 10, 10).total).toBe(0);
	});

	it('leaves out a component whose channel is missing', () => {
		const pw = powerChannels(get(['ips_coil_va']), p.n);
		expect(pw.missing).toEqual(['ips']);
		expect(pw.p_ips_kw).toBeUndefined();
		const e = energyKwh(pw, 0, 900);
		expect(e.ips).toBeNull();
		expect(e.total).toBe((e.motor as number) + (e.cooling as number));
	});

	it('does not throw with every source channel missing', () => {
		const pw = powerChannels(() => undefined, 5);
		expect(pw.missing).toEqual(['motor', 'ips', 'cooling']);
		expect(energyKwh(pw, 0, 5)).toEqual({ motor: null, ips: null, cooling: null, total: 0 });
	});
});
