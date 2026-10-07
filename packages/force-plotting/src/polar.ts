// Radius/angle pairs for the polar-plot panel. See
// docs/superpowers/specs/2026-09-07-milling-path-models-and-polar-design.md §6.
import { type Cache, idxOfTime, normStride } from './liveCache';
import { spindleAngle, type AngleParams } from './angle';
import type { PathWindow } from './path';

export type PolarRadius = 'Mz' | 'Fz' | 'Fxy';

export interface PolarParams {
	radius: PolarRadius;
	angle: AngleParams;
	window: PathWindow;
	// 0 = raw scatter (advisory for callers; buildPolar always returns raw per-point r/phi --
	// binning for display is the renderer's job).
	bins: number;
}

export interface PolarResult {
	r: Float32Array;
	phi: Float32Array;
	count: number;
	rMin: number; rMax: number;
	unit: 'N·m' | 'N';
	dropped: number;
}

export function buildPolar(c: Cache, p: PolarParams): PolarResult | null {
	const t = c.t;
	if (!t || t.length === 0 || c.N === 0) return null;
	if (p.radius === 'Mz' && !(c as any).Mz) return null;

	const cs = idxOfTime(t, p.window.cropStartSec);
	if (cs < 0) return null;
	const stride = normStride(p.window.stride);

	const idxAll: number[] = [];
	for (let i = cs; i < c.N; i += stride) {
		if (t[i] > p.window.cropEndSec) break;
		idxAll.push(i);
	}
	if (!idxAll.length) return null;
	const idx = Int32Array.from(idxAll);

	const phiAll = new Float32Array(idx.length);
	spindleAngle(c, p.angle, idx, phiAll);

	const src: Float32Array = p.radius === 'Mz' ? (c as any).Mz : p.radius === 'Fz' ? c.Fz : c.Fx;
	const srcY = p.radius === 'Fxy' ? c.Fy : null;

	const r = new Float32Array(idx.length);
	const phi = new Float32Array(idx.length);
	let m = 0, dropped = 0;
	let rMin = Infinity, rMax = -Infinity;
	for (let k = 0; k < idx.length; k++) {
		if (Number.isNaN(phiAll[k])) { dropped++; continue; }
		const i = idx[k];
		const v = srcY ? Math.hypot(src[i], srcY[i]) : src[i];
		r[m] = v; phi[m] = phiAll[k];
		if (v < rMin) rMin = v; if (v > rMax) rMax = v;
		m++;
	}
	const unit: 'N·m' | 'N' = p.radius === 'Mz' ? 'N·m' : 'N';
	if (!m) return { r: new Float32Array(0), phi: new Float32Array(0), count: 0, rMin: 0, rMax: 0, unit, dropped };
	return { r: r.subarray(0, m), phi: phi.subarray(0, m), count: m, rMin, rMax, unit, dropped };
}

// ---- Radial axis -------------------------------------------------------------------------------
// Distance from the centre is a linear function of the VALUE, from `lo` (centre) to `hi` (outer
// ring). `lo` is 0 for non-negative data, so a plain Fxy / positive-torque plot is unchanged. When
// data goes negative (Mz and Fz can) `lo` drops to the data minimum, so a negative value sits
// closer to the centre than a positive one instead of being plotted 180 degrees round, and an
// all-negative series no longer inverts the scale (the old `(r / rMax) * radius` with a negative
// rMax). The renderer labels the centre value and draws a zero ring when 0 is inside the plot.
export interface RadialScale {
	lo: number;   // value at the centre
	hi: number;   // value at the outer ring
}

export function radialScale(rMin: number, rMax: number, override?: number | null): RadialScale {
	const lo = Math.min(0, Number.isFinite(rMin) ? rMin : 0);
	let hi: number;
	if (override != null && Number.isFinite(override)) hi = override;
	else {
		const top = Number.isFinite(rMax) ? rMax : 0;
		hi = top + 0.05 * (top - lo);   // 5% headroom (for lo = 0 this is the old rMax * 1.05)
	}
	if (!(hi > lo)) hi = lo + 1;
	return { lo, hi };
}

/** Fraction of the plot radius (0 = centre, 1 = outer ring) for value `v`, clamped to the disc. */
export function radialFrac(v: number, s: RadialScale): number {
	const f = (v - s.lo) / (s.hi - s.lo);
	return f < 0 ? 0 : f > 1 ? 1 : f;
}
