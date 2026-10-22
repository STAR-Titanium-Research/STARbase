// The one table of Conform figures as the PDF appendix writes them: labels in sentence case, units, and the number rule.
//
// MIRROR of packages/fast-plotting/src/conform/format.ts (CONFORM_FIGURES, niceNumber, figureNumber, formatFigure, formatDuration, DASH).
// d1-report is not a workspace and cannot import @d1/fast-plotting, so it keeps a copy, the way it keeps a copy of the choice labels. A test
// in src/index.test.mjs reads format.ts and fails when the two tables or the number rule drift apart: change both together.
// Plain JS, no imports, so both the bundler and `node --test` load it as it is.

/** What a figure with no reading prints as: an em dash, with no unit. */
export const DASH = '—';

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const pad2 = (n) => String(n).padStart(2, '0');

/** `n` to `digits` decimals with no unit, or null for no reading. */
export const fixed = (n, digits) => (finite(n) ? n.toFixed(digits) : null);

export const KWH_UNIT = 'kWh';
export const KW_UNIT = 'kW';

/** A length of time: `12 min 05 s` under an hour, `1 h 23 min` from an hour. A dash for no reading. */
export function formatDuration(seconds) {
	if (!finite(seconds) || seconds < 0) return DASH;
	const s = Math.round(seconds);
	if (s < 3600) return `${Math.floor(s / 60)} min ${pad2(s % 60)} s`;
	return `${Math.floor(s / 3600)} h ${pad2(Math.floor((s % 3600) / 60))} min`;
}

/** DESIGN.md 5b's number rule: integers from 100, one decimal from 10, up to two below, without trailing zeros. Null for no reading. */
export function niceNumber(n) {
	if (!finite(n)) return null;
	const a = Math.abs(n);
	const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
	return String(Number(n.toFixed(digits)));
}

/** Every Conform summary figure, keyed by its summary key (energy parts as `energy_<part>`). */
export const CONFORM_FIGURES = {
	duration_s: { label: 'Duration', unit: '', kind: 'duration' },
	extruding_s: { label: 'Extruding time', unit: '', kind: 'duration' },
	mean_wheel_speed_rpm: { label: 'Mean wheel speed', unit: 'rpm', kind: 'nice' },
	mean_torque_pct: { label: 'Mean motor torque', unit: '%', kind: 'nice' },
	mean_tooling1_c: { label: 'Mean tooling 1', unit: '°C', kind: 'nice' },
	peak_torque_pct: { label: 'Peak motor torque', unit: '%', kind: 'nice' },
	peak_motor_current_a: { label: 'Peak motor current', unit: 'A', kind: 'nice' },
	peak_tooling1_c: { label: 'Peak tooling 1', unit: '°C', kind: 'nice' },
	peak_wheel_temp_c: { label: 'Peak wheel temperature', unit: '°C', kind: 'nice' },
	ips_setpoint_c: { label: 'IPS setpoint', unit: '°C', kind: 'nice' },
	energy_motor: { label: 'Motor energy', unit: KWH_UNIT, kind: 'kwh' },
	energy_ips: { label: 'IPS energy', unit: KWH_UNIT, kind: 'kwh' },
	energy_cooling: { label: 'Cooling energy', unit: KWH_UNIT, kind: 'kwh' },
	energy_total: { label: 'Total energy', unit: KWH_UNIT, kind: 'kwh' },
	avg_demand_kw: { label: 'Average demand', unit: KW_UNIT, kind: 'kw' },
};

/** The number of a figure without its unit (`402`, `8.04`, `7.52`, `12 min 05 s`), or null for no reading. */
export function figureNumber(key, value) {
	const f = CONFORM_FIGURES[key];
	if (!finite(value)) return null;
	if (f.kind === 'duration') return formatDuration(value);
	if (f.kind === 'kwh' || f.kind === 'kw') return fixed(value, 2);
	return niceNumber(value);
}

/** A figure with its unit (`402 °C`, `7.52 kWh`, `12 min 05 s`), or an em dash with no unit for no reading. */
export function formatFigure(key, value) {
	const n = figureNumber(key, value);
	if (n === null) return DASH;
	const unit = CONFORM_FIGURES[key].unit;
	return unit ? `${n} ${unit}` : n;
}
