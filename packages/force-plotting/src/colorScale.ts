// CloudCompare-style scalar-field colour scale: a SATURATION range (where the colour ramp hits
// its end colours) kept separate from a DISPLAYED range (a filter -- points outside are hidden or
// greyed), plus the parameters that reshape the saturation mapping itself (symmetrical,
// always-show-zero, log scale) and a step/quantisation count for the ramp.
//
// Design constraint this module exists to satisfy: every renderer's shader keeps computing colour
// with the SAME linear lookup it already uses today --
//   ct = clamp((value - satMin) / (satMax - satMin), 0, 1); colour = texture2D(uColormap, ct)
// -- unchanged. Every parameter below (symmetrical/zero/steps/log) is baked CPU-side into the LUT
// buildScaleLUT() produces; the only shader change this feature needs anywhere is a displayed-range
// branch, added per-renderer in later stages of the FRM colour-scale port
// (see .claude/plans/parallel-drifting-twilight.md).
//
// Log scale semantics (signed data, e.g. Fx spans roughly -100..+100 N): symmetric log,
// sign(v)*log1p(|v|) -- defined at 0, monotonic, signed. buildScaleLUT samples this at LINEARLY
// spaced raw values across [satMin, satMax] (matching the shader's linear index), so at a coarse
// `steps` count a log ramp becomes visibly BANDED -- logarithmically spaced colour bands on an
// otherwise linear value axis. That is the intended reading of "log scale + coarse steps", not a
// bug to "fix" by moving log() into GLSL.

import { COLORMAPS } from './liveCloud';

export interface ColorScale {
	colormap: string;
	steps: number;                          // ramp quantisation, 2..256
	satMin: number; satMax: number;         // saturation range -> ramp endpoints (AFTER shaping)
	// The saturation range BEFORE symmetrical / always-show-zero shaping: what the user or the
	// auto-range chose. satMin/satMax are always derived from it, so unticking a shaping param gives
	// the original range back instead of the widened one (#78). Optional: a scale built without
	// them treats its satMin/satMax as the base.
	baseMin?: number; baseMax?: number;
	dispMin: number; dispMax: number;       // displayed range -> filter window
	greyOutOfRange: boolean;                // true = grey out-of-displayed-range points, false = hide
	alwaysShowZero: boolean;
	symmetrical: boolean;
	logScale: boolean;
	barVisible: boolean;
}

// NaN-safe clamp -- same convention as liveCloud.ts's clamp01: a NaN reaching a shader renders as
// undefined (often solid white/garbage) colour, so every boundary here defends against it rather
// than propagating it.
const clamp01 = (v: number) => (Number.isNaN(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v);

function symlog(v: number): number {
	return Number.isFinite(v) ? Math.sign(v) * Math.log1p(Math.abs(v)) : 0;
}
function invSymlog(sv: number): number {
	return Math.sign(sv) * (Math.exp(Math.abs(sv)) - 1);
}

// A finite stand-in for "the displayed-range filter is off." GLSL ES 1.00 (three.js's default
// WebGL1 path) does not guarantee IEEE Infinity semantics in a uniform, so an actual +-Infinity
// here would be one driver quirk away from silently misbehaving; 1e20 is unambiguously outside any
// real force (N), residual, or z-score while staying far from float32 overflow (~3.4e38).
// Exported so every consumer that needs an inert displayed range (e.g. an overlay with no
// host-driven ColorScale yet) uses this exact value rather than each picking its own.
export const OPEN_DISP = 1e20;

export function defaultScale(lo: number, hi: number): ColorScale {
	if (!(hi > lo)) hi = lo + 1;   // degenerate guard, mirrors axisAutoLimits' `if (!(hi > lo))`
	return {
		colormap: 'viridis', steps: 256,
		satMin: lo, satMax: hi, baseMin: lo, baseMax: hi,
		// Deliberately NOT [lo, hi]: satMin/satMax are commonly a PERCENTILE range (e.g.
		// axisAutoLimits' 1st/99th), so ~2% of real points sit outside them by construction. If
		// the displayed range defaulted to the saturation range, greyOutOfRange's default (true,
		// below) would immediately greyle out those tail points instead of showing their existing
		// clamped colormap-endpoint colour -- a silent behaviour change the moment ANY host uses
		// this factory with a percentile range, which is the common case. A freshly defaulted scale
		// must filter nothing until something -- a user, via the editor -- deliberately narrows it.
		dispMin: -OPEN_DISP, dispMax: OPEN_DISP,
		greyOutOfRange: true, alwaysShowZero: false, symmetrical: false, logScale: false,
		barVisible: true,
	};
}

// The saturation range after the shaping params: symmetrical mirrors it about 0 on the larger
// magnitude, always-show-zero widens it to include 0.
function shapeRange(lo: number, hi: number, symmetrical: boolean, alwaysShowZero: boolean): [number, number] {
	if (symmetrical) {
		const M = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
		lo = -M; hi = M;
	}
	if (alwaysShowZero) {
		if (lo > 0) lo = 0;
		if (hi < 0) hi = 0;
	}
	return [lo, hi];
}

// Is [satMin, satMax] what some combination of the shaping params makes of [baseMin, baseMax]?
// Then it is derived and the base is still authoritative; if not, something wrote satMin/satMax
// directly (a Sat field, a host re-seed that spread the scale) and that value is the new base.
function isDerivedFrom(satMin: number, satMax: number, baseMin: number, baseMax: number): boolean {
	const tol = 1e-9 * Math.max(1, Math.abs(satMin), Math.abs(satMax), Math.abs(baseMin), Math.abs(baseMax));
	for (const sym of [false, true]) for (const zero of [false, true]) {
		const [lo, hi] = shapeRange(baseMin, baseMax, sym, zero);
		if (Math.abs(lo - satMin) <= tol && Math.abs(hi - satMax) <= tol) return true;
	}
	return false;
}

// Re-derives satMin/satMax/dispMin/dispMax from the current scale's params. Pure and idempotent --
// applying it twice in a row is a no-op. `dataLo`/`dataHi` are used only to repair a degenerate
// saturation range (e.g. a freshly defaulted scale, or NaN survivors), never to auto-widen a range
// the user has already set.
//
// Shaping is applied to the unshaped base range (baseMin/baseMax), never to an already-shaped
// satMin/satMax, so it is reversible: untick symmetrical and the range goes back to what it was.
export function applyParams(s: ColorScale, dataLo: number, dataHi: number): ColorScale {
	// A cleared <input v-model.number> yields '' (not NaN), which `>` would silently coerce to 0;
	// normalise anything that isn't a finite number so it takes the repair paths below instead.
	const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
	let satMin = fin(s.satMin), satMax = fin(s.satMax);
	let dispMin = fin(s.dispMin), dispMax = fin(s.dispMax);

	if (Number.isNaN(satMin)) satMin = Number.isNaN(satMax) || dataLo < satMax ? dataLo : satMax - 1;
	if (Number.isNaN(satMax)) satMax = dataHi > satMin ? dataHi : satMin + 1;
	if (Number.isNaN(dispMin)) dispMin = -OPEN_DISP;
	if (Number.isNaN(dispMax)) dispMax = OPEN_DISP;

	if (!(satMax > satMin)) {
		satMin = dataLo; satMax = dataHi;
		if (!(satMax > satMin)) { satMin = 0; satMax = 1; }
	}
	// Which range the shaping starts from.
	let baseMin = fin(s.baseMin), baseMax = fin(s.baseMax);
	if (!(baseMax > baseMin) || !isDerivedFrom(satMin, satMax, baseMin, baseMax)) { baseMin = satMin; baseMax = satMax; }
	[satMin, satMax] = shapeRange(baseMin, baseMax, s.symmetrical, s.alwaysShowZero);
	if (!(dispMax > dispMin)) { dispMin = satMin; dispMax = satMax; }

	return { ...s, satMin, satMax, baseMin, baseMax, dispMin, dispMax };
}

// Raw value -> colour-ramp position (0..1). Symlog-aware: under logScale this is the nonlinear
// tLog(v) the module header describes: buildScaleLUT samples THIS at linearly spaced v, which is
// what produces the banding rather than a continuously compressed axis.
export function normalize(v: number, s: ColorScale): number {
	if (!Number.isFinite(v)) return 0;
	let lo = s.satMin, hi = s.satMax;
	if (!(hi > lo)) hi = lo + 1e-9;
	if (s.logScale) {
		const slo = symlog(lo), shi = symlog(hi);
		const denom = shi - slo || 1e-9;
		return clamp01((symlog(v) - slo) / denom);
	}
	return clamp01((v - lo) / (hi - lo));
}

// Inverse of normalize: colour-ramp position (0..1) -> the raw value that produces it. Exact
// inverse under both linear and symlog mapping -- `normalize(denormalize(t, s), s) === t` for any
// t in [0,1] (see colorScale.test.ts's round-trip coverage). NOTE: the default colorbar rendering
// (ColorBar.vue) places its tick labels LINEARLY in value space via niceTicks over
// [satMin, satMax] -- matching buildScaleLUT's linear-in-v indexing, so no shader/index math ever
// needs to change -- and does not call this. denormalize exists for: (a) round-trip testing of
// normalize itself, and (b) an optional colour-space-uniform tick mode (ticks placed at even ramp
// positions rather than even values, useful for a log scale where the interesting detail is
// otherwise squeezed into a sliver of the bar) that a future UI pass may opt into.
export function denormalize(t: number, s: ColorScale): number {
	const tc = clamp01(t);
	let lo = s.satMin, hi = s.satMax;
	if (!(hi > lo)) hi = lo + 1e-9;
	if (s.logScale) {
		const slo = symlog(lo), shi = symlog(hi);
		return invSymlog(slo + tc * (shi - slo));
	}
	return lo + tc * (hi - lo);
}

// Colour at a ramp position (0..1), quantised to `steps` -- the same banding buildScaleLUT bakes,
// exposed standalone so a non-WebGL consumer (frmExport.ts's 2D-canvas colorbar) renders pixel-
// identical bands to what the GPU LUT shows on screen, rather than a smooth re-sample that would
// silently diverge from it.
export function sampleScale(t: number, s: ColorScale): [number, number, number] {
	const fn = COLORMAPS[s.colormap] || COLORMAPS.viridis;
	const w = Math.max(2, Math.round(s.steps) || 256);
	const tc = clamp01(t);
	const qi = Math.round(tc * (w - 1));
	return fn(qi / (w - 1));
}

// Convenience: raw value straight to a (quantised, symlog-aware) colour in one call.
export function sampleScaleAt(v: number, s: ColorScale): [number, number, number] {
	return sampleScale(normalize(v, s), s);
}

// CPU mirror of frmCloudShader.ts's colour branch, for renderers that bake per-vertex colour:
// linear LUT index over [satMin, satMax] (same as every shader), out-of-displayed-range points grey
// or alpha 0 (hidden -- the host material's alphaTest drops them). `out` is RGBA8, stride 4 --
// upload it as a normalized attribute.
export function colorizeValues(vals: ArrayLike<number>, count: number, s: ColorScale, out: Uint8Array, lutWidth = 1024): void {
	const w = Math.max(2, lutWidth);
	const lut = buildScaleLUT(s, w);
	const lo = s.satMin, span = s.satMax > s.satMin ? s.satMax - s.satMin : 1;
	const dLo = s.dispMin, dHi = s.dispMax, grey = s.greyOutOfRange;
	for (let k = 0; k < count; k++) {
		const v = vals[k];
		const o = k * 4;
		if (v < dLo || v > dHi) {
			out[o] = out[o + 1] = out[o + 2] = 128;
			out[o + 3] = grey ? 255 : 0;
			continue;
		}
		let t = (v - lo) / span;
		t = t > 0 ? (t < 1 ? t : 1) : 0;   // also maps NaN to 0, like clamp01
		const i = Math.round(t * (w - 1)) * 4;
		out[o] = lut[i]; out[o + 1] = lut[i + 1]; out[o + 2] = lut[i + 2];
		out[o + 3] = 255;
	}
}

// Re-seed the saturation range from an auto-detected [lo, hi], keeping every other setting.
export function withAutoRange(s: ColorScale, lo: number, hi: number): ColorScale {
	return applyParams({ ...s, satMin: lo, satMax: hi, baseMin: lo, baseMax: hi }, lo, hi);
}

// Displayed-range filter off -- for when the data it was set against changes.
export function withOpenDisplay(s: ColorScale): ColorScale {
	return { ...s, dispMin: -OPEN_DISP, dispMax: OPEN_DISP };
}

// Everything buildScaleLUT's bytes depend on. Renderers compare this, not individual fields, to
// decide when to rebuild their texture: under logScale the LUT also bakes in the saturation range.
export function lutKey(s: ColorScale): string {
	const base = `${s.colormap}|${s.steps}|${s.logScale ? 1 : 0}`;
	return s.logScale ? `${base}|${s.satMin}|${s.satMax}` : base;
}

// Build an RGBA8 colour-ramp LUT for GPU upload (THREE.DataTexture), `width` samples wide. Mirrors
// frmCloudShader.ts's buildColormapLUT byte-for-byte (Uint8ClampedArray, explicit ArrayBuffer, RGBA
// stride 4) so it is a drop-in replacement at every call site that currently builds its own LUT --
// see Stage 1/3 of the colour-scale plan.
//
// `width` is the TEXTURE's sampling resolution (independent of `s.steps`, the user-facing band
// count) -- keep it high (default 256) regardless of `steps` so banding is controlled entirely by
// `steps`'s quantisation inside sampleScale, never additionally degraded by a coarse texture.
//
// Entries are sampled at LINEARLY spaced raw values across [satMin, satMax] (not linearly spaced
// ramp positions) -- this is what keeps every shader's existing `ct = (v - satMin)/(satMax - satMin)`
// linear lookup correct unchanged: index i already corresponds to raw value
// satMin + i/(width-1)*(satMax-satMin), so a linear-in-v shader index lands on the right entry
// regardless of whether logScale reshaped the COLOUR at that entry.
export function buildScaleLUT(s: ColorScale, width = 256): Uint8ClampedArray<ArrayBuffer> {
	const w = Math.max(2, Math.round(width) || 256);
	const out = new Uint8ClampedArray(new ArrayBuffer(w * 4));
	let lo = s.satMin, hi = s.satMax;
	if (!(hi > lo)) hi = lo + 1e-9;
	const span = hi - lo;
	for (let i = 0; i < w; i++) {
		const v = lo + (i / (w - 1)) * span;
		const [r, g, b] = sampleScale(normalize(v, s), s);
		out[i * 4] = Math.round(r * 255);
		out[i * 4 + 1] = Math.round(g * 255);
		out[i * 4 + 2] = Math.round(b * 255);
		out[i * 4 + 3] = 255;
	}
	return out;
}
