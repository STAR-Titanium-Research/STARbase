import { describe, expect, it } from 'vitest';
import { edgeOccluded } from './labels';

// The camera looks down from above, in front of corner 2 (+z): the usual insert framing.
const fromAboveFront: [number, number, number] = [0, 40, 60];

describe('edgeOccluded', () => {
	it('fades an underside letter whose corner faces away from the camera', () => {
		expect(edgeOccluded({ faceY: -1, outward: [0, -8] }, fromAboveFront)).toBe(true);
	});

	it('keeps an underside letter on the corner facing the camera (its rim is visible)', () => {
		expect(edgeOccluded({ faceY: -1, outward: [0, 8] }, fromAboveFront)).toBe(false);
	});

	it('never fades a top-face letter seen from above', () => {
		expect(edgeOccluded({ faceY: 1, outward: [0, -8] }, fromAboveFront)).toBe(false);
	});

	it('leaves labels without a face alone (slot numbers)', () => {
		expect(edgeOccluded({}, fromAboveFront)).toBe(false);
	});
});
