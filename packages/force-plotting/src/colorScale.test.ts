// Coverage for colorScale.ts's pure maths: the linear/symlog normalize<->denormalize round trip,
// the invariants applyParams enforces (symmetrical, always-show-zero), sampleScale's step
// quantisation, and NaN safety -- a NaN reaching a shader as a vertex colour is this codebase's
// most recurring real bug (see liveCloud.test.ts's header), so every boundary here is checked
// against it explicitly rather than assumed.
import { describe, expect, it } from 'vitest';
import {
	applyParams, buildScaleLUT, colorizeValues, defaultScale, denormalize, lutKey, normalize, OPEN_DISP, sampleScale,
	sampleScaleAt, withAutoRange, withOpenDisplay, type ColorScale,
} from './colorScale';

function scale(overrides: Partial<ColorScale> = {}): ColorScale {
	return { ...defaultScale(-10, 10), ...overrides };
}

describe('defaultScale', () => {
	it('spans the given range with sane defaults', () => {
		const s = defaultScale(0, 100);
		expect(s).toMatchObject({
			satMin: 0, satMax: 100,
			colormap: 'viridis', steps: 256, logScale: false, symmetrical: false, alwaysShowZero: false,
			greyOutOfRange: true, barVisible: true,
		});
	});
	it('repairs a degenerate (hi <= lo) range rather than dividing by zero downstream', () => {
		const s = defaultScale(5, 5);
		expect(s.satMax).toBeGreaterThan(s.satMin);
		const s2 = defaultScale(5, 2);
		expect(s2.satMax).toBeGreaterThan(s2.satMin);
	});
	it('leaves the displayed-range filter wide open regardless of the saturation range', () => {
		// satMin/satMax are commonly a PERCENTILE range (e.g. axisAutoLimits' 1st/99th), so a
		// freshly defaulted scale must never filter/grey a point just because it falls outside
		// [satMin, satMax] -- that decision belongs to a user narrowing the range deliberately,
		// via the editor, not to this factory's defaults.
		const s = defaultScale(1, 99);   // narrower than the data range below, like a percentile clip
		expect(s.dispMin).toBeLessThanOrEqual(0);
		expect(s.dispMax).toBeGreaterThanOrEqual(100);
		// A value outside the saturation range (a real tail point under a percentile auto-range)
		// must NOT be outside the displayed range -- the exact bug this test pins.
		const tailValue = 100;
		expect(tailValue).toBeGreaterThan(s.satMax);
		expect(tailValue).toBeGreaterThanOrEqual(s.dispMin);
		expect(tailValue).toBeLessThanOrEqual(s.dispMax);
	});
	it('uses a finite sentinel for the open displayed range, not literal Infinity', () => {
		// GLSL ES 1.00 (three.js's default WebGL1 path) does not guarantee IEEE Infinity semantics
		// in a uniform -- OPEN_DISP must be finite so it survives a GPU uniform upload correctly.
		const s = defaultScale(0, 1);
		expect(Number.isFinite(s.dispMin)).toBe(true);
		expect(Number.isFinite(s.dispMax)).toBe(true);
		expect(s.dispMin).toBe(-OPEN_DISP);
		expect(s.dispMax).toBe(OPEN_DISP);
	});
});

describe('applyParams', () => {
	it('is a no-op when no shaping params are set and the range is already valid', () => {
		const s = scale({ satMin: -3, satMax: 7 });
		expect(applyParams(s, -100, 100)).toEqual(s);
	});
	it('symmetrical forces satMin = -satMax using the larger magnitude', () => {
		const s = applyParams(scale({ symmetrical: true, satMin: -2, satMax: 9 }), 0, 0);
		expect(s.satMax).toBe(9);
		expect(s.satMin).toBe(-9);
	});
	it('alwaysShowZero widens a range that does not already contain zero', () => {
		const above = applyParams(scale({ alwaysShowZero: true, satMin: 2, satMax: 9 }), 0, 0);
		expect(above.satMin).toBe(0); expect(above.satMax).toBe(9);
		const below = applyParams(scale({ alwaysShowZero: true, satMin: -9, satMax: -2 }), 0, 0);
		expect(below.satMin).toBe(-9); expect(below.satMax).toBe(0);
	});
	it('alwaysShowZero is a no-op when zero is already inside the range', () => {
		const s = applyParams(scale({ alwaysShowZero: true, satMin: -5, satMax: 5 }), 0, 0);
		expect(s.satMin).toBe(-5); expect(s.satMax).toBe(5);
	});
	it('symmetrical and alwaysShowZero together are consistent (symmetrical already contains zero)', () => {
		const s = applyParams(scale({ symmetrical: true, alwaysShowZero: true, satMin: 3, satMax: 8 }), 0, 0);
		expect(s.satMin).toBe(-8); expect(s.satMax).toBe(8);
	});
	it('repairs a degenerate saturation range from the supplied data bounds', () => {
		const s = applyParams(scale({ satMin: 4, satMax: 4 }), -50, 50);
		expect(s.satMin).toBe(-50); expect(s.satMax).toBe(50);
	});
	it('falls back to 0..1 when both the scale and the data bounds are degenerate', () => {
		const s = applyParams(scale({ satMin: 4, satMax: 4 }), 4, 4);
		expect(s.satMax).toBeGreaterThan(s.satMin);
	});
	it('repairs a degenerate displayed range by resetting it to the saturation range', () => {
		const s = applyParams(scale({ satMin: -10, satMax: 10, dispMin: 3, dispMax: 3 }), 0, 0);
		expect(s.dispMin).toBe(-10); expect(s.dispMax).toBe(10);
	});
	it('never auto-widens a displayed range the user set deliberately', () => {
		const s = applyParams(scale({ satMin: -10, satMax: 10, dispMin: -2, dispMax: 4 }), 0, 0);
		expect(s.dispMin).toBe(-2); expect(s.dispMax).toBe(4);
	});
	it('replaces a cleared saturation field (v-model.number yields "") with the data bound', () => {
		const lo = applyParams(scale({ satMin: '' as unknown as number, satMax: 50 }), -20, 80);
		expect(lo.satMin).toBe(-20); expect(lo.satMax).toBe(50);
		const hi = applyParams(scale({ satMin: -5, satMax: '' as unknown as number }), -20, 80);
		expect(hi.satMin).toBe(-5); expect(hi.satMax).toBe(80);
	});
	it('keeps a cleared saturation end below the other end when the data bound would cross it', () => {
		const s = applyParams(scale({ satMin: NaN, satMax: -30 }), -20, 80);
		expect(s.satMax).toBe(-30);
		expect(s.satMin).toBeLessThan(s.satMax);
	});
	it('reopens a cleared displayed-range field instead of treating it as 0', () => {
		const s = applyParams(scale({ satMin: -10, satMax: 10, dispMin: '' as unknown as number, dispMax: 4 }), 0, 0);
		expect(s.dispMin).toBe(-OPEN_DISP); expect(s.dispMax).toBe(4);
		const t = applyParams(scale({ dispMin: -2, dispMax: NaN }), 0, 0);
		expect(t.dispMin).toBe(-2); expect(t.dispMax).toBe(OPEN_DISP);
	});
	it('never returns a non-number field', () => {
		const s = applyParams(scale({ satMin: '' as unknown as number, satMax: '' as unknown as number, dispMin: '' as unknown as number, dispMax: '' as unknown as number }), 0, 100);
		for (const k of ['satMin', 'satMax', 'dispMin', 'dispMax'] as const) {
			expect(typeof s[k]).toBe('number');
			expect(Number.isFinite(s[k])).toBe(true);
		}
	});
});

describe('colorizeValues', () => {
	it('matches the LUT colour for in-range values, including steps and log scale', () => {
		const s = scale({ satMin: -100, satMax: 100, steps: 8, logScale: true });
		const vals = new Float32Array([-100, -3, 0, 7, 100]);
		const out = new Uint8Array(vals.length * 4);
		colorizeValues(vals, vals.length, s, out, 256);
		const lut = buildScaleLUT(s, 256);
		vals.forEach((v, k) => {
			const i = Math.round(((v + 100) / 200) * 255) * 4;
			expect(out[k * 4]).toBe(lut[i]);
			expect(out[k * 4 + 1]).toBe(lut[i + 1]);
			expect(out[k * 4 + 3]).toBe(255);
		});
	});
	it('greys or hides points outside the displayed range', () => {
		const vals = new Float32Array([-50, 0, 50]);
		const out = new Uint8Array(12);
		colorizeValues(vals, 3, scale({ satMin: -100, satMax: 100, dispMin: -10, dispMax: 10, greyOutOfRange: true }), out);
		expect(Array.from(out.slice(0, 4))).toEqual([128, 128, 128, 255]);
		expect(out[7]).toBe(255);
		colorizeValues(vals, 3, scale({ satMin: -100, satMax: 100, dispMin: -10, dispMax: 10, greyOutOfRange: false }), out);
		expect(out[3]).toBe(0); expect(out[7]).toBe(255); expect(out[11]).toBe(0);
	});
	it('maps NaN to the low end of the ramp rather than an undefined colour', () => {
		const s = scale();
		const out = new Uint8Array(4);
		colorizeValues(new Float32Array([NaN]), 1, s, out, 256);
		const lut = buildScaleLUT(s, 256);
		expect(Array.from(out)).toEqual([lut[0], lut[1], lut[2], 255]);
	});
});

describe('withAutoRange / withOpenDisplay', () => {
	it('re-seeds only the saturation range and still applies the shaping params', () => {
		const s = withAutoRange(scale({ symmetrical: true, colormap: 'inferno', dispMin: -2, dispMax: 2 }), 10, 30);
		expect([s.satMin, s.satMax]).toEqual([-30, 30]);
		expect(s.colormap).toBe('inferno');
		expect([s.dispMin, s.dispMax]).toEqual([-2, 2]);
	});
	it('reopens the displayed range without touching anything else', () => {
		const s = withOpenDisplay(scale({ satMin: -3, satMax: 3, dispMin: -1, dispMax: 1 }));
		expect([s.dispMin, s.dispMax]).toEqual([-OPEN_DISP, OPEN_DISP]);
		expect([s.satMin, s.satMax]).toEqual([-3, 3]);
	});
});

describe('lutKey', () => {
	it('changes when logScale toggles', () => {
		expect(lutKey(scale({ logScale: true }))).not.toBe(lutKey(scale({ logScale: false })));
	});
	it('tracks the saturation range only under logScale', () => {
		expect(lutKey(scale({ satMin: -5, satMax: 5 }))).toBe(lutKey(scale({ satMin: 0, satMax: 9 })));
		expect(lutKey(scale({ logScale: true, satMin: -5, satMax: 5 })))
			.not.toBe(lutKey(scale({ logScale: true, satMin: 0, satMax: 9 })));
	});
	it('is equal exactly when buildScaleLUT output is equal, across the fields that matter', () => {
		const a = scale({ logScale: true, satMin: -100, satMax: 100, steps: 16 });
		const b = scale({ logScale: true, satMin: 0, satMax: 100, steps: 16 });
		expect(Array.from(buildScaleLUT(a))).not.toEqual(Array.from(buildScaleLUT(b)));
		expect(lutKey(a)).not.toBe(lutKey(b));
		const c = { ...a, dispMin: -3, dispMax: 3, greyOutOfRange: false };
		expect(Array.from(buildScaleLUT(c))).toEqual(Array.from(buildScaleLUT(a)));
		expect(lutKey(c)).toBe(lutKey(a));
	});
});

describe('normalize (linear)', () => {
	const s = scale({ satMin: -10, satMax: 10, logScale: false });
	it('maps the endpoints to 0 and 1', () => {
		expect(normalize(-10, s)).toBe(0);
		expect(normalize(10, s)).toBe(1);
	});
	it('maps the midpoint to 0.5', () => {
		expect(normalize(0, s)).toBeCloseTo(0.5, 10);
	});
	it('clamps values outside the saturation range', () => {
		expect(normalize(-999, s)).toBe(0);
		expect(normalize(999, s)).toBe(1);
	});
	it('is NaN-safe: a non-finite value normalizes to 0, never NaN', () => {
		expect(normalize(NaN, s)).toBe(0);
		expect(normalize(Infinity, s)).toBe(0);
	});
	it('does not divide by zero on a degenerate saturation range', () => {
		const deg = scale({ satMin: 5, satMax: 5 });
		expect(Number.isNaN(normalize(5, deg))).toBe(false);
	});
});

describe('normalize (symlog)', () => {
	const s = scale({ satMin: -100, satMax: 100, logScale: true });
	it('still maps the endpoints to 0 and 1', () => {
		expect(normalize(-100, s)).toBeCloseTo(0, 6);
		expect(normalize(100, s)).toBeCloseTo(1, 6);
	});
	it('maps zero to the midpoint on a range symmetric about zero', () => {
		expect(normalize(0, s)).toBeCloseTo(0.5, 6);
	});
	it('is monotonically increasing (a defining property of a valid colour ramp position)', () => {
		const samples = [-100, -50, -10, -1, 0, 1, 10, 50, 100];
		const positions = samples.map((v) => normalize(v, s));
		for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
	});
	it('expands near-zero detail relative to the linear mapping (the whole point of log scale)', () => {
		const lin = scale({ satMin: -100, satMax: 100, logScale: false });
		// A small value near zero moves FURTHER from the midpoint under symlog than under a linear
		// mapping (v=5 out of +-100 barely nudges a linear position, but symlog gives it real visual
		// separation) -- that expanded near-zero contrast is exactly what log scale is for.
		const linGap = Math.abs(normalize(5, lin) - 0.5);
		const logGap = Math.abs(normalize(5, s) - 0.5);
		expect(logGap).toBeGreaterThan(linGap);
	});
});

describe('normalize <-> denormalize round trip', () => {
	it('is an exact inverse under a linear scale', () => {
		const s = scale({ satMin: -30, satMax: 70, logScale: false });
		for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
			expect(normalize(denormalize(t, s), s)).toBeCloseTo(t, 9);
		}
	});
	it('is an exact inverse under a symlog scale, including a range that does not span zero', () => {
		const s = scale({ satMin: -40, satMax: 200, logScale: true });
		for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
			expect(normalize(denormalize(t, s), s)).toBeCloseTo(t, 6);
		}
		const positive = scale({ satMin: 5, satMax: 500, logScale: true });
		for (const t of [0, 0.3, 0.6, 1]) {
			expect(normalize(denormalize(t, positive), positive)).toBeCloseTo(t, 6);
		}
	});
	it('denormalize recovers the saturation endpoints at t=0 and t=1', () => {
		const s = scale({ satMin: -17, satMax: 43, logScale: true });
		expect(denormalize(0, s)).toBeCloseTo(-17, 6);
		expect(denormalize(1, s)).toBeCloseTo(43, 6);
	});
});

describe('sampleScale', () => {
	it('returns a finite [r,g,b] in 0..1 across the full domain, never NaN', () => {
		const s = scale();
		for (let i = 0; i <= 20; i++) {
			const [r, g, b] = sampleScale(i / 20, s);
			for (const c of [r, g, b]) {
				expect(Number.isFinite(c)).toBe(true);
				expect(c).toBeGreaterThanOrEqual(0);
				expect(c).toBeLessThanOrEqual(1);
			}
		}
	});
	it('quantises to `steps` distinct colours -- coarse steps visibly band the ramp', () => {
		const s = scale({ steps: 4 });
		const seen = new Set<string>();
		for (let i = 0; i <= 100; i++) seen.add(sampleScale(i / 100, s).map((c) => c.toFixed(4)).join(','));
		expect(seen.size).toBeLessThanOrEqual(4);
	});
	it('a full-resolution scale (steps=256) is effectively continuous over a coarse sample', () => {
		const s = scale({ steps: 256 });
		const seen = new Set<string>();
		for (let i = 0; i <= 20; i++) seen.add(sampleScale(i / 20, s).map((c) => c.toFixed(4)).join(','));
		expect(seen.size).toBeGreaterThan(4);
	});
	it('falls back to viridis for an unknown colormap name rather than throwing', () => {
		const s = scale({ colormap: 'not-a-real-map' });
		expect(() => sampleScale(0.5, s)).not.toThrow();
	});
});

describe('sampleScaleAt', () => {
	it('agrees with calling normalize then sampleScale directly', () => {
		const s = scale({ satMin: -5, satMax: 5 });
		expect(sampleScaleAt(2, s)).toEqual(sampleScale(normalize(2, s), s));
	});
});

describe('buildScaleLUT', () => {
	it('produces an RGBA8 buffer of the requested width with alpha always opaque', () => {
		const s = scale();
		const lut = buildScaleLUT(s, 32);
		expect(lut.length).toBe(32 * 4);
		for (let i = 0; i < 32; i++) expect(lut[i * 4 + 3]).toBe(255);
	});
	it('defaults to a 256-wide texture', () => {
		expect(buildScaleLUT(scale()).length).toBe(256 * 4);
	});
	it('the first and last entries match the colour at the saturation endpoints', () => {
		const s = scale({ satMin: -10, satMax: 10 });
		const lut = buildScaleLUT(s, 16);
		const [r0, g0, b0] = sampleScaleAt(-10, s);
		const [r1, g1, b1] = sampleScaleAt(10, s);
		expect(lut[0]).toBeCloseTo(Math.round(r0 * 255), 0);
		expect(lut[1]).toBeCloseTo(Math.round(g0 * 255), 0);
		expect(lut[2]).toBeCloseTo(Math.round(b0 * 255), 0);
		const last = 15;
		expect(lut[last * 4]).toBeCloseTo(Math.round(r1 * 255), 0);
		expect(lut[last * 4 + 1]).toBeCloseTo(Math.round(g1 * 255), 0);
		expect(lut[last * 4 + 2]).toBeCloseTo(Math.round(b1 * 255), 0);
	});
	it('never produces NaN/undefined bytes, even on a degenerate saturation range', () => {
		const s = scale({ satMin: 5, satMax: 5 });
		const lut = buildScaleLUT(s, 8);
		for (let i = 0; i < lut.length; i++) {
			expect(Number.isFinite(lut[i])).toBe(true);
		}
	});
	it('log scale produces visibly fewer distinct colours than steps at a coarse count (banding)', () => {
		const s = scale({ satMin: -100, satMax: 100, logScale: true, steps: 8 });
		const lut = buildScaleLUT(s, 256);
		const seen = new Set<string>();
		for (let i = 0; i < 256; i++) seen.add(`${lut[i * 4]},${lut[i * 4 + 1]},${lut[i * 4 + 2]}`);
		expect(seen.size).toBeLessThanOrEqual(8);
	});
});
