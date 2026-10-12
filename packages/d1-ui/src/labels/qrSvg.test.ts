import { describe, expect, it } from 'vitest';
import { qrSvg } from './qrSvg';

describe('qrSvg', () => {
	it('draws runs of dark modules inside a quiet zone', () => {
		// 3x3:  X . X
		//       X X X
		//       . . .
		const svg = qrSvg({ size: 3, data: [1, 0, 1, 1, 1, 1, 0, 0, 0] });
		expect(svg).toContain('viewBox="0 0 7 7"');
		expect(svg).toContain('M2 2h1v1h-1z');
		expect(svg).toContain('M4 2h1v1h-1z');
		expect(svg).toContain('M2 3h3v1h-3z');
		expect(svg.match(/M[0-9]/g)).toHaveLength(3);
	});
	it('accepts booleans and a typed array', () => {
		expect(qrSvg({ size: 1, data: [true] })).toContain('M2 2h1v1h-1z');
		expect(qrSvg({ size: 2, data: new Uint8Array([1, 1, 0, 1]) })).toContain('M2 2h2v1h-2z');
	});
	it('has nothing but the svg and its path, and no external references', () => {
		const svg = qrSvg({ size: 2, data: [1, 0, 0, 1] });
		expect(svg.startsWith('<svg ')).toBe(true);
		expect(svg).not.toMatch(/<script|href|https?:|url\(|on\w+=/i);
	});
	it('gives nothing for an unusable matrix', () => {
		expect(qrSvg({ size: 0, data: [] })).toBe('');
		expect(qrSvg({ size: 3, data: [1, 1] })).toBe('');
		expect(qrSvg({ size: 1.5, data: [1, 1, 1] })).toBe('');
		expect(qrSvg(null as never)).toBe('');
	});
});
