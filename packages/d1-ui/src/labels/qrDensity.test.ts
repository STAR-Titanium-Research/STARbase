import { describe, expect, it } from 'vitest';
import { chooseQr, MIN_MODULE_MM, moduleMm, WARN_MODULE_MM, type QrLevel } from './qrDensity';

// A fake encoder: M needs more modules than L, as in the real thing.
const SIZES: Record<QrLevel, number> = { M: 57, L: 49 };
const fake = (_p: string, level: QrLevel) => ({ size: SIZES[level], data: [] as number[] });

describe('moduleMm', () => {
	it('shares the box between the modules and the two quiet zones', () => {
		expect(moduleMm(61, 57)).toBeCloseTo(1, 6);
		expect(moduleMm(30, 26)).toBeCloseTo(1, 6);
	});
});

describe('chooseQr', () => {
	it('keeps error correction M while its modules are at least 0.33 mm', () => {
		const box = (57 + 4) * MIN_MODULE_MM;
		expect(chooseQr('x', box, fake)).toMatchObject({ level: 'M', modules: { size: 57 } });
		expect(chooseQr('x', box + 5, fake).level).toBe('M');
	});
	it('falls back to L when M would make the modules smaller than 0.33 mm', () => {
		const box = (57 + 4) * MIN_MODULE_MM - 0.5;
		const c = chooseQr('x', box, fake);
		expect(c.level).toBe('L');
		expect(c.modules.size).toBe(49);
		expect(c.moduleMm).toBeCloseTo(box / 53, 6);
	});
	it('reports the module size at L even when it is under the 0.3 mm warning line', () => {
		const c = chooseQr('x', 15, fake);
		expect(c.level).toBe('L');
		expect(c.moduleMm).toBeLessThan(WARN_MODULE_MM);
	});
	it('does not build the L matrix when M is big enough', () => {
		const levels: QrLevel[] = [];
		chooseQr('x', 100, (p, l) => (levels.push(l), fake(p, l)));
		expect(levels).toEqual(['M']);
	});
});
