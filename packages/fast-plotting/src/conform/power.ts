// Electrical power of a Conform run, from the maintainer's spreadsheet formulas ("Power & Cost" tab).

export const CONFORM_POWER_CONSTANTS = { voltage_v: 400, cos_phi_motor: 0.85, k_ips: 0.95, cos_phi_cooling: 0.80, version: 1 };

export type PowerPart = 'motor' | 'ips' | 'cooling';
export interface PowerChannels {
	p_motor_kw?: Float64Array; p_ips_kw?: Float64Array; p_cooling_kw?: Float64Array; p_total_kw: Float64Array; missing: PowerPart[];
}
export interface EnergyKwh { motor: number | null; ips: number | null; cooling: number | null; total: number }

const scaled = (src: Float64Array, n: number, k: number): Float64Array => {
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = src[i] * k;
	return out;
};

/**
 * One kW value per row. A part whose source channel is missing is left out and listed in `missing`.
 * Negative currents are kept as logged. `p_total_kw` is the sum of the parts that are present (NaN
 * where none of them has a value).
 */
export function powerChannels(get: (key: string) => Float64Array | undefined, n: number): PowerChannels {
	const c = CONFORM_POWER_CONSTANTS;
	const three = Math.sqrt(3) * c.voltage_v / 1000;
	const motorI = get('motor_current_a');
	const coilVa = get('ips_coil_va');
	const coolI = get('wheel_cooling_pump_current_a');
	const out: PowerChannels = { p_total_kw: new Float64Array(n), missing: [] };
	if (motorI) out.p_motor_kw = scaled(motorI, n, three * c.cos_phi_motor); else out.missing.push('motor');
	if (coilVa) out.p_ips_kw = scaled(coilVa, n, c.k_ips / 1000); else out.missing.push('ips');
	if (coolI) out.p_cooling_kw = scaled(coolI, n, three * c.cos_phi_cooling); else out.missing.push('cooling');
	const parts = [out.p_motor_kw, out.p_ips_kw, out.p_cooling_kw].filter((p): p is Float64Array => !!p);
	for (let i = 0; i < n; i++) {
		let sum = 0;
		let any = false;
		for (const p of parts) if (Number.isFinite(p[i])) { sum += p[i]; any = true; }
		out.p_total_kw[i] = any ? sum : NaN;
	}
	return out;
}

const kwh = (p: Float64Array | undefined, from: number, to: number): number | null => {
	if (!p) return null;
	let s = 0;
	for (let i = from; i < to; i++) if (Number.isFinite(p[i])) s += p[i];
	return s / 3600;
};

/** Energy over rows [from, to), at 1 s per row. */
export function energyKwh(p: PowerChannels, from: number, to: number): EnergyKwh {
	const n = p.p_total_kw.length;
	const a = Math.max(0, Math.min(n, from));
	const b = Math.max(a, Math.min(n, to));
	const motor = kwh(p.p_motor_kw, a, b);
	const ips = kwh(p.p_ips_kw, a, b);
	const cooling = kwh(p.p_cooling_kw, a, b);
	return { motor, ips, cooling, total: (motor ?? 0) + (ips ?? 0) + (cooling ?? 0) };
}
