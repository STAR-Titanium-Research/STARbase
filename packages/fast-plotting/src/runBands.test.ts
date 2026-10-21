import { describe, expect, it } from 'vitest';
import { drawBands, fitLabel, hoverTime, windowZoom } from './runBands';
import type { RunWindowBand } from './profile';

describe('hoverTime', () => {
	it('is the elapsed time alone without a clock origin (FAST)', () => {
		expect(hoverTime(125, null)).toEqual({ clock: '02:05', elapsed: '', wall: false });
		expect(hoverTime(3725, undefined)).toEqual({ clock: '1:02:05', elapsed: '', wall: false });
	});
	it('is UK local time of day with the elapsed time beside it, across the clock change', () => {
		expect(hoverTime(125, Date.parse('2025-03-17T09:00:00Z'))).toEqual({ clock: '09:02:05', elapsed: '02:05', wall: true });
		expect(hoverTime(0, Date.parse('2025-06-17T09:00:00Z')).clock).toBe('10:00:00');   // BST
	});
});

const band = (operationId: string, startS: number, endS: number, current = false, label = operationId): RunWindowBand => ({ operationId, label, startS, endS, current });

describe('drawBands', () => {
	const sx = (t: number) => 44 + (t / 1000) * 300;   // 0..1000 s over 300 px
	it('draws each band inside the view, clipped to it, with its label', () => {
		const out = drawBands([band('a', 100, 400, false, 'Feedstock A'), band('b', 900, 1500, true, 'B')], 0, 1000, sx);
		expect(out.map((b) => [b.key, b.current])).toEqual([['a', false], ['b', true]]);
		expect(out[0].x).toBeCloseTo(74); expect(out[0].width).toBeCloseTo(90);
		expect(out[1].x).toBeCloseTo(314); expect(out[1].width).toBeCloseTo(30);   // clipped at 1000 s
		expect(out[0].label).toBe('Feedstock A');
	});
	it('drops bands outside the view', () => {
		expect(drawBands([band('a', 0, 100), band('c', 2000, 3000)], 500, 1000, sx)).toEqual([]);
	});
	it('draws nothing for no bands', () => {
		expect(drawBands([], 0, 1000, sx)).toEqual([]);
	});
});

describe('fitLabel', () => {
	it('keeps a label that fits, cuts one that does not, and drops it when there is no room', () => {
		expect(fitLabel('AA6082', 100)).toBe('AA6082');
		expect(fitLabel('A very long feedstock name', 70)).toMatch(/…$/);
		expect(fitLabel('A very long feedstock name', 70).length).toBeLessThan(14);
		expect(fitLabel('AA6082', 20)).toBe('');
	});
});

describe('windowZoom', () => {
	it('opens on the window with a little context, inside the trace', () => {
		expect(windowZoom({ startS: 600, endS: 1200 }, 0, 7200)).toEqual({ start: 582, end: 1218 });
		expect(windowZoom({ startS: 2, endS: 7199 }, 0, 7200)).toEqual({ start: 0, end: 7200 });
	});
	it('has no zoom for an empty window', () => {
		expect(windowZoom({ startS: 5, endS: 5 }, 0, 100)).toBeNull();
	});
});
