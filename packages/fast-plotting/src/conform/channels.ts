// The Conform channel catalogue and header normalisation. Pure: no Vue, no network.

export type ConformGroup = 'speed' | 'torque' | 'current' | 'temp' | 'power' | 'ips' | 'cooling' | 'other';
export interface ConformChannel { key: string; label: string; unit: string; group: ConformGroup; note?: string }

/** The reason a log was refused; the message is shown to the user as is. */
export class ConformLogError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConformLogError';
	}
}

interface CatalogueEntry { header: string; key: string; label: string; unit: string; group: ConformGroup }

// In display order. `header` is the canonical machine header (unit included).
const CATALOGUE: CatalogueEntry[] = [
	{ header: 'Wheel Speed (rpm)', key: 'wheel_speed_rpm', label: 'Wheel speed', unit: 'rpm', group: 'speed' },
	{ header: 'Wheel Speed Demand (rpm)', key: 'wheel_speed_demand_rpm', label: 'Wheel speed demand', unit: 'rpm', group: 'speed' },
	{ header: 'Motor Current (A)', key: 'motor_current_a', label: 'Motor current', unit: 'A', group: 'current' },
	{ header: 'Motor Torque (%)', key: 'motor_torque_pct', label: 'Motor torque', unit: '%', group: 'torque' },
	{ header: 'Tooling Temperature 1 (°C)', key: 'tooling1_c', label: 'Tooling 1 (behind abutment)', unit: '°C', group: 'temp' },
	{ header: 'Tooling Temperature 2 (°C)', key: 'tooling2_c', label: 'Tooling 2 (die exit)', unit: '°C', group: 'temp' },
	{ header: 'Wheel Temperature (°C)', key: 'wheel_temp_c', label: 'Wheel temperature', unit: '°C', group: 'temp' },
	{ header: 'Wheel Temperature 1 (°C)', key: 'wheel_temp1_c', label: 'Wheel temperature 1', unit: '°C', group: 'temp' },
	{ header: 'Wheel Temperature 2 (°C)', key: 'wheel_temp2_c', label: 'Wheel temperature 2', unit: '°C', group: 'temp' },
	{ header: 'IPS Control Temperature (°C)', key: 'ips_control_c', label: 'IPS control temperature', unit: '°C', group: 'ips' },
	{ header: 'IPS Coolant Temp (°C)', key: 'ips_coolant_c', label: 'IPS coolant temperature', unit: '°C', group: 'ips' },
	{ header: 'IPS Output (%)', key: 'ips_output_pct', label: 'IPS output', unit: '%', group: 'ips' },
	{ header: 'IPS Setpoint (°C)', key: 'ips_setpoint_c', label: 'IPS setpoint', unit: '°C', group: 'ips' },
	{ header: 'IPS Work Coil VA', key: 'ips_coil_va', label: 'IPS work coil', unit: 'VA', group: 'ips' },
	{ header: 'Wheel Cooling Pump Current (A)', key: 'wheel_cooling_pump_current_a', label: 'Wheel cooling pump current', unit: 'A', group: 'cooling' },
	{ header: 'Wheel Cooling Demand (%)', key: 'wheel_cooling_demand_pct', label: 'Wheel cooling demand', unit: '%', group: 'cooling' },
	{ header: 'Wheel Cooling Pump Torque (%)', key: 'wheel_cooling_pump_torque_pct', label: 'Wheel cooling pump torque', unit: '%', group: 'cooling' },
	{ header: 'Machine Cooling Temp. (°C)', key: 'machine_cooling_c', label: 'Machine cooling temperature', unit: '°C', group: 'cooling' },
	{ header: 'Product Cooling Temp. (°C)', key: 'product_cooling_c', label: 'Product cooling temperature', unit: '°C', group: 'cooling' },
	{ header: 'Bearing Oil Temperature (°C)', key: 'bearing_oil_c', label: 'Bearing oil temperature', unit: '°C', group: 'temp' },
	{ header: 'Gearbox Oil Temperature (°C)', key: 'gearbox_oil_c', label: 'Gearbox oil temperature', unit: '°C', group: 'temp' },
	{ header: 'Powder Feeder Demand (%)', key: 'powder_feeder_demand_pct', label: 'Powder feeder demand', unit: '%', group: 'other' },
	{ header: 'Powder Feeder Setting (%)', key: 'powder_feeder_setting_pct', label: 'Powder feeder setting', unit: '%', group: 'other' },
	{ header: 'Analogue Input 1', key: 'analogue_input_1', label: 'Analogue input 1', unit: '', group: 'other' },
];

/** The derived power channels, in the order they are stored (last in the normalised CSV). */
export const POWER_CHANNELS: ConformChannel[] = [
	{ key: 'p_motor_kw', label: 'Motor power', unit: 'kW', group: 'power' },
	{ key: 'p_ips_kw', label: 'IPS power', unit: 'kW', group: 'power' },
	{ key: 'p_cooling_kw', label: 'Cooling power', unit: 'kW', group: 'power' },
	{ key: 'p_total_kw', label: 'Total power', unit: 'kW', group: 'power' },
];

// Computed or junk columns an Excel export drags along. Matched on the header's name without its unit.
const IGNORED_NAMES = new Set(['pwcool', 'pips', 'pmotor', 'column1', 'tm', 'tm4']);

/** Mojibake and unit spellings made uniform. */
export function cleanHeader(raw: string): string {
	return raw
		.replace(/^﻿/, '')
		.replace(/Â(?=[°º])/g, '')
		.replace(/º/g, '°')
		.replace(/\uFFFD(?=C)/g, '°')   // a degree sign a lossy decode replaced
		.replace(/\s+/g, ' ')
		.trim();
}

const normUnit = (u: string): string => (u === 'C' ? '°C' : u);

export interface ParsedHeader { name: string; unit: string; note: string }

/** `Name (unit) - note` into its parts. The unit is the last `(...)` when it looks like a unit. */
export function parseHeader(cleaned: string): ParsedHeader {
	const m = /^(.*)\(([^()]*)\)([^()]*)$/.exec(cleaned);
	if (m && /^[^\s()]{1,8}$/.test(m[2].trim()) && m[1].trim()) {
		return {
			name: m[1].trim(),
			unit: normUnit(m[2].trim()),
			note: m[3].replace(/^[\s\-–—]+/, '').trim(),
		};
	}
	return { name: cleaned, unit: '', note: '' };
}

const lookupKey = (name: string, unit: string): string => `${name.toLowerCase()}|${unit}`;
const LOOKUP = new Map<string, CatalogueEntry>(
	CATALOGUE.map((e) => {
		const h = parseHeader(e.header);
		return [lookupKey(h.name, h.unit), e] as [string, CatalogueEntry];
	}),
);
/** Position of a key in the catalogue, for ordering. Unknown keys sort after. */
const ORDER = new Map(CATALOGUE.map((e, i) => [e.key, i]));
export const catalogueOrder = (key: string): number => ORDER.get(key) ?? CATALOGUE.length;

const UNIT_SUFFIX: Record<string, string> = { '°C': '_c', '%': '_pct', A: '_a', rpm: '_rpm', VA: '_va', kW: '_kw' };
const UNIT_GROUP: Record<string, ConformGroup> = { '°C': 'temp', A: 'current', rpm: 'speed', '%': 'other', kW: 'power' };

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export type HeaderClass =
	| { kind: 'channel'; channel: ConformChannel }
	| { kind: 'ignored' };

/** Decide what a CSV header (not the Timestamp one) is. `cleaned` comes from `cleanHeader`. */
export function classifyHeader(cleaned: string): HeaderClass {
	const h = parseHeader(cleaned);
	if (IGNORED_NAMES.has(h.name.toLowerCase())) return { kind: 'ignored' };
	const known = LOOKUP.get(lookupKey(h.name, h.unit));
	if (known) {
		const channel: ConformChannel = { key: known.key, label: known.label, unit: known.unit, group: known.group };
		if (h.note) channel.note = h.note;
		return { kind: 'channel', channel };
	}
	if (!h.unit) return { kind: 'ignored' };
	const key = slug(h.name) + (UNIT_SUFFIX[h.unit] ?? '_x');
	if (!slug(h.name)) return { kind: 'ignored' };
	const channel: ConformChannel = { key, label: h.name, unit: h.unit, group: UNIT_GROUP[h.unit] ?? 'other' };
	if (h.note) channel.note = h.note;
	return { kind: 'channel', channel };
}
