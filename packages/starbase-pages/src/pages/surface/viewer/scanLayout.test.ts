import { describe, expect, it } from 'vitest';
import { parseMeta, type GridStats } from './gridData';
import {
	defaultExaggeration, EXAG_MAX, EXAG_MIN, exaggerationToSlider, fitDistance, formatExaggeration, formatMicrometres, frameCamera, heightRange,
	pitchText, scanLayout, sizeText, SLIDER_STEPS, sliderToExaggeration,
} from './scanLayout';

const meta = (o: Record<string, unknown> = {}) => parseMeta({ width: 101, height: 51, pixel_pitch_x_um: 10, pixel_pitch_y_um: 10, z_min_um: -5, z_max_um: 15, ...o });
const stats = (min: number, max: number, valid = 10): GridStats => ({ min, max, valid, missing: 0 });

describe('scanLayout', () => {
	it('sizes the plane from the pitch, longer side 1', () => {
		const l = scanLayout(meta());
		expect(l.extentXUm).toBe(1000);
		expect(l.extentZUm).toBe(500);
		expect(l.sizeX).toBe(1);
		expect(l.sizeZ).toBeCloseTo(0.5, 10);
		expect(l.umToScene).toBeCloseTo(0.001, 10);
		expect(l.pitchKnown).toBe(true);
	});
	it('keeps a non-square pitch in the aspect', () => {
		const l = scanLayout(meta({ pixel_pitch_y_um: 40 }));
		expect(l.sizeZ).toBe(1);
		expect(l.sizeX).toBeCloseTo(0.5, 10);
	});
	it('draws square cells when the file states no pitch', () => {
		const l = scanLayout(meta({ pixel_pitch_x_um: null, pixel_pitch_y_um: null }));
		expect(l.pitchKnown).toBe(false);
		expect(l.sizeZ).toBeCloseTo(0.5, 10);
	});
});

describe('heightRange', () => {
	it("prefers the file's own range", () => {
		expect(heightRange(meta(), stats(0, 1))).toEqual({ min: -5, max: 15 });
	});
	it('falls back to the grid, then to a thin span, never an empty one', () => {
		expect(heightRange(meta({ z_min_um: null, z_max_um: null }), stats(2, 9))).toEqual({ min: 2, max: 9 });
		const flat = heightRange(meta({ z_min_um: 3, z_max_um: 3 }), stats(4, 4));
		expect(flat.max).toBeGreaterThan(flat.min);
		const empty = heightRange(meta({ z_min_um: null, z_max_um: null }), stats(0, 0, 0));
		expect(empty.max).toBeGreaterThan(empty.min);
	});
});

describe('exaggeration slider', () => {
	it('is logarithmic from 1x to 1000x and round-trips', () => {
		expect(sliderToExaggeration(0)).toBe(EXAG_MIN);
		expect(sliderToExaggeration(SLIDER_STEPS)).toBeCloseTo(EXAG_MAX, 6);
		expect(sliderToExaggeration(SLIDER_STEPS / 2)).toBeCloseTo(Math.sqrt(EXAG_MAX), 6);
		for (const x of [1, 2.5, 10, 120, 1000]) expect(sliderToExaggeration(exaggerationToSlider(x))).toBeCloseTo(x, 0);
	});
	it('clamps what is out of range', () => {
		expect(sliderToExaggeration(-50)).toBe(EXAG_MIN);
		expect(sliderToExaggeration(5000)).toBeCloseTo(EXAG_MAX, 6);
		expect(exaggerationToSlider(0.01)).toBe(0);
		expect(exaggerationToSlider(1e9)).toBe(SLIDER_STEPS);
	});
	it('starts so that the relief reads at a tenth of the scan, at least true scale', () => {
		const l = scanLayout(meta()); // 1000 um across
		expect(defaultExaggeration(l, { min: 0, max: 5 })).toBe(20);
		expect(defaultExaggeration(l, { min: 0, max: 400 })).toBe(1);
		expect(defaultExaggeration(l, { min: 0, max: 30 })).toBe(3.3);
		expect(defaultExaggeration(l, { min: 0, max: 0 })).toBe(1);
		expect(defaultExaggeration(l, { min: 0, max: 0.001 })).toBe(EXAG_MAX);
	});
	it('prints a short label', () => {
		expect(formatExaggeration(1)).toBe('1×');
		expect(formatExaggeration(3.34)).toBe('3.3×');
		expect(formatExaggeration(120.4)).toBe('120×');
	});
});

describe('frameCamera', () => {
	const l = scanLayout(meta());
	it('puts the whole surface in view and limits the zoom around that', () => {
		const f = frameCamera(l, { min: 0, max: 20 }, 10, 1.5);
		expect(f.distance).toBeGreaterThan(0.5);
		expect(f.minDistance).toBeLessThan(f.distance);
		expect(f.maxDistance).toBeGreaterThan(f.distance);
		expect(f.near).toBeLessThan(f.minDistance);
		expect(f.far).toBeGreaterThan(f.maxDistance);
		expect(f.maxPolarDeg).toBeLessThan(90);
		expect(f.minPolarDeg).toBeGreaterThan(0);
	});
	it('backs off for a taller (exaggerated) surface and for a narrow view', () => {
		const low = frameCamera(l, { min: 0, max: 20 }, 1, 1.5).distance;
		const tall = frameCamera(l, { min: 0, max: 20 }, 1000, 1.5).distance;
		expect(tall).toBeGreaterThan(low);
		expect(fitDistance(1, 35, 0.5)).toBeGreaterThan(fitDistance(1, 35, 2));
	});
});

describe('legend text', () => {
	it('formats micrometres with a true minus and a size-appropriate precision', () => {
		expect(formatMicrometres(-5)).toBe('−5.00 µm');
		expect(formatMicrometres(15.04)).toBe('15.0 µm');
		expect(formatMicrometres(1234.5)).toBe('1235 µm');
		expect(formatMicrometres(null)).toBe('–');
		expect(formatMicrometres(NaN)).toBe('–');
	});
	it('says the pitch and the size the file states', () => {
		expect(pitchText(meta())).toBe('10 µm');
		expect(pitchText(meta({ pixel_pitch_x_um: 5.2, pixel_pitch_y_um: 4.8 }))).toBe('5.2 × 4.8 µm');
		expect(pitchText(meta({ pixel_pitch_x_um: null }))).toBe('not stated in the file');
		expect(sizeText(meta())).toBe('101 × 51 cells');
		expect(sizeText(meta({ source_width: 4096, source_height: 2048 }))).toBe('101 × 51 cells (from 4096 × 2048)');
		expect(sizeText(meta({ source_width: 101, source_height: 51 }))).toBe('101 × 51 cells');
	});
});
