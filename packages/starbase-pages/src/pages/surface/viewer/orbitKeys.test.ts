import { describe, expect, it } from 'vitest';
import { KEY_TURN_RAD, KEY_ZOOM, keyStep, orbitPosition, orbitState, type OrbitLimits, type OrbitState } from './orbitKeys';

const LIM: OrbitLimits = { minPolar: 0.1, maxPolar: 1.5, minDistance: 1, maxDistance: 10 };
const S: OrbitState = { azimuth: 0.5, polar: 0.9, distance: 4 };

describe('keyStep', () => {
	it('turns around the surface with left and right, and towards the top with up', () => {
		expect(keyStep('ArrowLeft', S, LIM)!.azimuth).toBeCloseTo(0.5 - KEY_TURN_RAD);
		expect(keyStep('ArrowRight', S, LIM)!.azimuth).toBeCloseTo(0.5 + KEY_TURN_RAD);
		expect(keyStep('ArrowUp', S, LIM)!.polar).toBeCloseTo(0.9 - KEY_TURN_RAD);
		expect(keyStep('ArrowDown', S, LIM)!.polar).toBeCloseTo(0.9 + KEY_TURN_RAD);
	});
	it('zooms with plus and minus', () => {
		expect(keyStep('+', S, LIM)!.distance).toBeCloseTo(4 * KEY_ZOOM);
		expect(keyStep('=', S, LIM)!.distance).toBeCloseTo(4 * KEY_ZOOM);
		expect(keyStep('-', S, LIM)!.distance).toBeCloseTo(4 / KEY_ZOOM);
	});
	it('stays inside the limits: never under the surface, never past the zoom range', () => {
		expect(keyStep('ArrowDown', { ...S, polar: 1.5 }, LIM)!.polar).toBe(1.5);
		expect(keyStep('ArrowUp', { ...S, polar: 0.1 }, LIM)!.polar).toBe(0.1);
		expect(keyStep('+', { ...S, distance: 1 }, LIM)!.distance).toBe(1);
		expect(keyStep('-', { ...S, distance: 10 }, LIM)!.distance).toBe(10);
	});
	it('leaves other keys alone (Tab must still leave the canvas)', () => {
		for (const k of ['Tab', 'Enter', 'a', 'Escape', 'PageUp']) expect(keyStep(k, S, LIM)).toBeNull();
	});
});

describe('orbitPosition and orbitState', () => {
	it('are inverse, and a camera at the opening azimuth sits to the right of and in front of the surface', () => {
		const [x, y, z] = orbitPosition(S);
		expect(x).toBeGreaterThan(0);
		expect(y).toBeGreaterThan(0);
		expect(z).toBeGreaterThan(0);
		const back = orbitState(x, y, z);
		expect(back.azimuth).toBeCloseTo(S.azimuth);
		expect(back.polar).toBeCloseTo(S.polar);
		expect(back.distance).toBeCloseTo(S.distance);
	});
});
