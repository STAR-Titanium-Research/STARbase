import { describe, expect, it } from 'vitest';
import { RAMP_STOPS, rampBytes, rampColour, rampCss } from './colourRamp';

describe('rampColour', () => {
	it('starts and ends on the end stops and clamps outside', () => {
		expect(rampColour(0)).toEqual([0x44, 0x01, 0x54]);
		expect(rampColour(1)).toEqual([0xfd, 0xe7, 0x25]);
		expect(rampColour(-3)).toEqual(rampColour(0));
		expect(rampColour(7)).toEqual(rampColour(1));
		expect(rampColour(NaN)).toEqual(rampColour(0));
	});
	it('hits a stop exactly and blends between two', () => {
		expect(rampColour(0.5)).toEqual([0x26, 0x82, 0x8e]);
		const mid = rampColour(0.0625);
		expect(mid[0]).toBeGreaterThan(0x44 - 1);
		expect(mid[0]).toBeLessThan(0x48 + 1);
	});
	it('gets lighter as it goes up (the ramp is monotone in lightness)', () => {
		const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
		let prev = -1;
		for (let i = 0; i <= 20; i++) {
			const l = lum(rampColour(i / 20));
			expect(l).toBeGreaterThan(prev);
			prev = l;
		}
	});
});

describe('rampBytes and rampCss', () => {
	it('is an opaque n x 1 RGBA strip', () => {
		const b = rampBytes(16);
		expect(b.length).toBe(64);
		expect(Array.from(b.slice(0, 4))).toEqual([0x44, 0x01, 0x54, 255]);
		expect(Array.from(b.slice(60, 64))).toEqual([0xfd, 0xe7, 0x25, 255]);
		for (let i = 3; i < b.length; i += 4) expect(b[i]).toBe(255);
	});
	it('names every stop in the legend gradient, highest at the top', () => {
		const css = rampCss();
		expect(css.startsWith('linear-gradient(to top,')).toBe(true);
		for (const s of RAMP_STOPS) expect(css).toContain(s.hex);
		expect(rampCss('to right')).toContain('to right');
	});
});
