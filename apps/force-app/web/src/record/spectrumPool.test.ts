import { describe, expect, it } from 'vitest';
import { maxPoolRows } from './spectrumPool';

describe('maxPoolRows', () => {
	it('returns a source that already fits unchanged', () => {
		const s = [1, 2, 3];
		expect(maxPoolRows(s, 3)).toBe(s);
		expect(maxPoolRows(s, 10)).toBe(s);
	});

	it('keeps a single narrow peak at full height wherever it falls', () => {
		for (const at of [0, 1, 500, 777, 1023]) {
			const s = new Array(1024).fill(0.001);
			s[at] = 5;
			const out = maxPoolRows(s, 300);
			expect(out.length).toBe(300);
			expect(Math.max(...Array.from(out))).toBeCloseTo(5, 5);
		}
	});

	it('covers every source bin exactly once, in order', () => {
		const s = Array.from({ length: 1000 }, (_, i) => i);
		const out = Array.from(maxPoolRows(s, 7));
		expect(out).toEqual([...out].sort((a, b) => a - b));
		expect(out[out.length - 1]).toBe(999);
	});
});
