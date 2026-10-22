import { describe, expect, it } from 'vitest';
import { excelVariant, fixtureText } from './__fixtures__/load';
import { ConformLogError } from './channels';
import { parseConformCsv } from './parse';

const EXPECTED_KEYS = [
	'wheel_speed_rpm', 'wheel_speed_demand_rpm', 'motor_current_a', 'motor_torque_pct', 'tooling1_c', 'tooling2_c',
	'wheel_temp_c', 'wheel_temp1_c', 'wheel_temp2_c', 'ips_control_c', 'ips_coolant_c', 'ips_output_pct', 'ips_setpoint_c',
	'ips_coil_va', 'wheel_cooling_pump_current_a', 'wheel_cooling_demand_pct', 'wheel_cooling_pump_torque_pct',
	'machine_cooling_c', 'product_cooling_c', 'bearing_oil_c', 'gearbox_oil_c', 'powder_feeder_demand_pct',
	'powder_feeder_setting_pct', 'analogue_input_1',
];

describe('parseConformCsv', () => {
	it('parses the synthetic log', () => {
		const p = parseConformCsv(fixtureText);
		expect(p.n).toBe(900);
		expect(p.startMs).toBe(Date.UTC(2025, 0, 15, 10, 0, 0));
		expect(p.endMs).toBe(Date.UTC(2025, 0, 15, 10, 14, 59));
		expect(p.gaps).toBe(0);
		expect(p.time[0]).toBe(0);
		expect(p.time[899]).toBe(899);
		expect(p.ignored).toEqual([]);
		for (const k of EXPECTED_KEYS) expect(p.channels.map((c) => c.key), k).toContain(k);
		expect(p.channels).toHaveLength(EXPECTED_KEYS.length);
		expect(p.channels.find((c) => c.key === 'tooling1_c')!.label).toBe('Tooling 1 (behind abutment)');
		expect(p.channels.find((c) => c.key === 'tooling2_c')!.label).toBe('Tooling 2 (die exit)');
		expect(p.values.motor_current_a[0]).toBe(16.2);
		expect(p.values.ips_setpoint_c[0]).toBe(500);
	});

	it('reads an Excel export to the same channels as the clean file', () => {
		const clean = parseConformCsv(fixtureText);
		const x = parseConformCsv(excelVariant(fixtureText));
		expect(x.channels.map((c) => c.key)).toEqual(clean.channels.map((c) => c.key));
		expect(x.channels.map((c) => c.unit)).toEqual(clean.channels.map((c) => c.unit));
		expect(x.ignored).toEqual(expect.arrayContaining(['Column1', 'Pmotor', 'PIPS']));
		expect(x.ignored).toHaveLength(3);
		expect(x.n).toBe(900);
		expect(x.startMs).toBe(clean.startMs);
		expect(x.channels.find((c) => c.key === 'tooling2_c')!.note).toBe('Die exit');
		expect(x.values.tooling2_c[10]).toBe(clean.values.tooling2_c[10]);
	});

	it('maps annotated headers and passes a unit-bearing unknown header through', () => {
		const csv = [
			'Timestamp,"Tooling Temperature 1 (°C) - behind abutment",Calculated Temperature (ºC),Mystery Signal,Flow (l/min),tm (K),h(Ttc -Tair)',
			'2025-03-17T13:38:20.0000000Z,300,25,1,2,3,4',
			'2025-03-17T13:38:21.0000000Z,301,26,1,2,3,4',
		].join('\n');
		const p = parseConformCsv(csv);
		const t1 = p.channels.find((c) => c.key === 'tooling1_c')!;
		expect(t1.unit).toBe('°C');
		expect(t1.note).toBe('behind abutment');
		expect(t1.label).toBe('Tooling 1 (behind abutment)');
		const calc = p.channels.find((c) => c.key === 'calculated_temperature_c')!;
		expect(calc).toMatchObject({ unit: '°C', group: 'temp' });
		expect(p.channels.find((c) => c.key === 'flow_x')).toMatchObject({ unit: 'l/min', group: 'other' });
		expect(p.ignored).toEqual(expect.arrayContaining(['Mystery Signal', 'tm (K)', 'h(Ttc -Tair)']));
		expect(p.channels.map((c) => c.key)).not.toContain('tm_x');
	});

	it('counts non-numeric cells and gaps', () => {
		const csv = [
			'Timestamp,Wheel Speed (rpm)',
			'2025-03-17T13:38:20Z,1',
			'2025-03-17T13:38:21Z,abc',
			'2025-03-17T13:38:24Z,3',
		].join('\n');
		const p = parseConformCsv(csv);
		expect(p.n).toBe(3);
		expect(p.nonNumeric).toBe(1);
		expect(p.gaps).toBe(1);
		expect(Number.isNaN(p.values.wheel_speed_rpm[1])).toBe(true);
		expect(p.time[2]).toBe(4);
	});

	it('refuses malformed logs with a reason', () => {
		expect(() => parseConformCsv('Time,Wheel Speed (rpm)\n1,2\n2,3')).toThrow(ConformLogError);
		expect(() => parseConformCsv('Time,Wheel Speed (rpm)\n1,2\n2,3')).toThrow(/Timestamp/);
		expect(() => parseConformCsv('Timestamp,Wheel Speed (rpm)\n2025-03-17T13:38:20Z,1')).toThrow(ConformLogError);
		expect(() => parseConformCsv('Timestamp,Wheel Speed (rpm)\n2025-03-17T13:38:21Z,1\n2025-03-17T13:38:20Z,1')).toThrow(/increas/);
		expect(() => parseConformCsv('')).toThrow(ConformLogError);
		expect(() => parseConformCsv('Timestamp,Colour\n2025-03-17T13:38:20Z,1\n2025-03-17T13:38:21Z,2')).toThrow(ConformLogError);
	});
});
