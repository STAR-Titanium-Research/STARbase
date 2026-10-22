import { describe, expect, it } from 'vitest';
import { drawBands, fitLabel, hoverTime, viewIsOnBand, windowZoom } from './runBands';
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

describe('viewIsOnBand', () => {
	const win = { startS: 600, endS: 1200 };   // 600 s long: 10% is 60 s
	it('is true when the view is the window with its usual context, or a little more', () => {
		expect(viewIsOnBand(win, 582, 1218)).toBe(true);
		expect(viewIsOnBand(win, 540, 1260)).toBe(true);
		expect(viewIsOnBand(win, 600, 1200)).toBe(true);
		expect(viewIsOnBand(win, 650, 1100)).toBe(true);   // zoomed inside it
	});
	it('is false once the view reaches further than 10% beyond an end', () => {
		expect(viewIsOnBand(win, 539, 1200)).toBe(false);
		expect(viewIsOnBand(win, 600, 1261)).toBe(false);
		expect(viewIsOnBand(win, 0, 7200)).toBe(false);   // the whole log
	});
	it('is false for an empty window', () => {
		expect(viewIsOnBand({ startS: 5, endS: 5 }, 0, 10)).toBe(false);
	});
});

describe('drawBands modes and labels', () => {
	const sx = (t: number) => 44 + ((t - 500) / 800) * 300;   // 500..1300 s over 300 px
	const cur = { operationId: 'c', label: 'Ti swarf', startS: 600, endS: 1200, current: true };
	const other = { operationId: 'o', label: 'AA6082 swarf', startS: 100, endS: 700, current: false };
	it('draws the current run as two edges (no wash) when the view is on its window; otherwise, and for another run, a wash', () => {
		const wide = drawBands([other, cur], 500, 1300, sx);   // 100 s outside each end of a 600 s window: more than 10%
		expect(wide.map((b) => [b.key, b.mode])).toEqual([['o', 'wash'], ['c', 'wash']]);
		const on = drawBands([cur], 582, 1218, (t) => 44 + ((t - 582) / 636) * 300);
		expect(on[0]).toMatchObject({ mode: 'edges', startsInView: true, endsInView: true });
	});
	it('has no edge line at an end outside the view', () => {
		const [b] = drawBands([cur], 700, 1100, (t) => 44 + ((t - 700) / 400) * 300);
		expect(b).toMatchObject({ mode: 'edges', startsInView: false, endsInView: false });
	});
	it('starts a label after the y axis unit and cuts it to what is left of the band', () => {
		const [b] = drawBands([other], 100, 1300, (t) => 44 + ((t - 100) / 1200) * 300, 70);
		expect(b.x).toBeCloseTo(44);
		expect(b.labelX).toBe(70);   // the band starts under the unit, so its label starts after it
		const [narrow] = drawBands([{ ...other, endS: 160 }], 100, 1300, (t) => 44 + ((t - 100) / 1200) * 300, 70);
		expect(narrow.label).toBe('');   // 15 px of band, all of it under the unit: no room for even a few letters
	});
});
