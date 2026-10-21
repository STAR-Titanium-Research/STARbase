// Turn a parsed Conform log into the stored artefacts: the normalised CSV (column-aligned with `series`, the
// layout fastCache.parseTrace reads), the series catalogue and the whole-log totals.
import type { SeriesMeta } from '../fastCache';
import { POWER_CHANNELS, type ConformChannel } from './channels';
import type { ParsedConformLog } from './parse';
import { CONFORM_POWER_CONSTANTS, energyKwh, powerChannels, type EnergyKwh, type PowerPart } from './power';

export interface ConformTotals { duration_s: number; energy_kwh: EnergyKwh; avg_demand_kw: number; missing: PowerPart[] }
export interface NormalisedLog {
	csvText: string; series: SeriesMeta[]; totals: ConformTotals; constants: typeof CONFORM_POWER_CONSTANTS;
	logStart: string; logEnd: string; nRows: number; durationS: number;
}

const FLAT_BAND_C = 1;

function extent(v: Float64Array): { min: number | null; max: number | null; flat: boolean } {
	let min = Infinity;
	let max = -Infinity;
	let first = NaN;
	let count = 0;
	let flat = true;
	for (let i = 0; i < v.length; i++) {
		const x = v[i];
		if (!Number.isFinite(x)) continue;
		if (count === 0) first = x;
		count++;
		if (x < min) min = x;
		if (x > max) max = x;
		if (Math.abs(x - first) > FLAT_BAND_C) flat = false;
	}
	return count ? { min, max, flat: flat && count >= 2 } : { min: null, max: null, flat: false };
}

const meta = (c: ConformChannel, v: Float64Array): SeriesMeta => {
	const { min, max, flat } = extent(v);
	const m: SeriesMeta = { key: c.key, label: c.label, unit: c.unit, group: c.group, min, max };
	// A temperature that never leaves +-1 degC of its first value: possibly a disconnected thermocouple.
	if (c.group === 'temp' && flat) m.flat = true;
	return m;
};

// Source channels are written exactly (shortest round trip); derived ones to 9 significant digits, which is
// far below the effect on any energy figure and keeps a 100k-row log compact.
const exact = (x: number): string => (Number.isFinite(x) ? String(x) : '');
const derived = (x: number): string => (Number.isFinite(x) ? String(Number(x.toPrecision(9))) : '');

export function normaliseLog(log: ParsedConformLog): NormalisedLog {
	const n = log.n;
	const pw = powerChannels((k) => log.values[k], n);
	const cols: { channel: ConformChannel; values: Float64Array; fmt: (x: number) => string }[] = log.channels.map((channel) => ({
		channel, values: log.values[channel.key], fmt: exact,
	}));
	for (const channel of POWER_CHANNELS) {
		const values = pw[channel.key as 'p_motor_kw'];
		if (values) cols.push({ channel, values, fmt: derived });
	}

	const lines: string[] = ['time_s,' + cols.map((c) => c.channel.key).join(',')];
	for (let i = 0; i < n; i++) {
		const cells = new Array<string>(cols.length + 1);
		cells[0] = String(Number(log.time[i].toFixed(3)));
		for (let c = 0; c < cols.length; c++) cells[c + 1] = cols[c].fmt(cols[c].values[i]);
		lines.push(cells.join(','));
	}

	const durationS = log.time[n - 1] - log.time[0];
	const energy = energyKwh(pw, 0, n);
	return {
		csvText: lines.join('\n') + '\n',
		series: cols.map((c) => meta(c.channel, c.values)),
		totals: { duration_s: durationS, energy_kwh: energy, avg_demand_kw: (energy.total * 3600) / n, missing: pw.missing },
		constants: { ...CONFORM_POWER_CONSTANTS },
		logStart: new Date(log.startMs).toISOString(),
		logEnd: new Date(log.endMs).toISOString(),
		nRows: n,
		durationS,
	};
}
