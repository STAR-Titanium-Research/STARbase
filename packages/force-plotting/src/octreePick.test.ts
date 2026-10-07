import { describe, expect, it } from 'vitest';
import { shaderZ } from './octreePick';

describe('shaderZ', () => {
	it('is 0 when flat', () => { expect(shaderZ(5, 0, 10, 0)).toBe(0); });
	it('maps the range onto +-zScale/2', () => {
		expect(shaderZ(0, 0, 10, 20)).toBe(-10);
		expect(shaderZ(10, 0, 10, 20)).toBe(10);
		expect(shaderZ(5, 0, 10, 20)).toBe(0);
	});
	it('clamps outside the range', () => {
		expect(shaderZ(-50, 0, 10, 20)).toBe(-10);
		expect(shaderZ(50, 0, 10, 20)).toBe(10);
	});
	it('survives a degenerate range', () => { expect(Number.isFinite(shaderZ(1, 1, 1, 20))).toBe(true); });
});
