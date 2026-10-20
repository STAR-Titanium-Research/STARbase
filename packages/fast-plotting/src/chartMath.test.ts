import { describe, expect, it } from 'vitest';
import { clock, fmtNum, hasNoTileBelow, indexAt, niceStep, niceTicks, placeTiles, seriesStyle, tickLabel, ticksWithin, unitLabel } from './chartMath';

describe('niceStep', () => {
	it('picks 1, 2, 2.5 or 5 times a power of ten, never below the rough step', () => {
		expect(niceStep(0.9)).toBe(1);
		expect(niceStep(1.1)).toBe(2);
		expect(niceStep(2.2)).toBe(2.5);
		expect(niceStep(3)).toBe(5);
		expect(niceStep(6)).toBe(10);
		expect(niceStep(240)).toBe(250);
		expect(niceStep(0.03)).toBeCloseTo(0.05, 12);
	});
	it('can leave out 2.5', () => {
		expect(niceStep(2.2, [1, 2, 5])).toBe(5);
	});
});

describe('niceTicks', () => {
	it('puts the top tick above the data', () => {
		expect(niceTicks(0, 1362).ticks).toEqual([0, 500, 1000, 1500]);
		expect(niceTicks(0, 30).ticks).toEqual([0, 10, 20, 30, 40]);
		expect(niceTicks(0, 11.8).ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5]);
	});
	it('starts at or below the minimum, with negative values too', () => {
		const t = niceTicks(-3.2, 4.1).ticks;
		expect(t[0]).toBeLessThanOrEqual(-3.2);
		expect(t[t.length - 1]).toBeGreaterThan(4.1);
	});
	it('has a few ticks only, and copes with a flat range', () => {
		expect(niceTicks(0, 1362).ticks.length).toBeLessThanOrEqual(7);
		expect(niceTicks(5, 5).ticks.length).toBeGreaterThanOrEqual(2);
	});
	it('does not drift on fractional steps', () => {
		expect(niceTicks(0, 0.55).ticks).toEqual([0, 0.2, 0.4, 0.6]);
	});
});

describe('ticksWithin', () => {
	it('stays inside the range', () => {
		expect(ticksWithin(0, 45, 9, [1, 2, 5]).ticks).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45]);
		expect(ticksWithin(10, 24, 7, [1, 2, 5]).ticks).toEqual([10, 12, 14, 16, 18, 20, 22, 24]);
	});
});

describe('tickLabel', () => {
	it('uses the step to choose decimals and a real minus sign', () => {
		expect(tickLabel(1500, 500)).toBe('1500');
		expect(tickLabel(7.5, 2.5)).toBe('7.5');
		expect(tickLabel(0.2, 0.2)).toBe('0.2');
		expect(tickLabel(-4, 4)).toBe('−4');
	});
});

describe('unitLabel', () => {
	it('prints degrees Celsius with its sign and leaves other units alone', () => {
		expect(unitLabel('C')).toBe('°C');
		expect(unitLabel('kN')).toBe('kN');
	});
});

describe('indexAt', () => {
	const t = Float64Array.of(0, 10, 20, 40);
	it('finds the nearest sample', () => {
		expect(indexAt(t, -5)).toBe(0);
		expect(indexAt(t, 12)).toBe(1);
		expect(indexAt(t, 31)).toBe(3);
		expect(indexAt(t, 999)).toBe(3);
		expect(indexAt(new Float64Array(0), 3)).toBe(-1);
	});
});

describe('clock', () => {
	it('formats elapsed seconds', () => {
		expect(clock(1080)).toBe('18:00');
		expect(clock(65.4)).toBe('01:05');
		expect(clock(3723)).toBe('1:02:03');
		expect(clock(-3)).toBe('00:00');
	});
});

describe('seriesStyle', () => {
	it('uses the chart tokens with their own values as fallback, and dashes after the first series', () => {
		expect(seriesStyle(0)).toEqual({ color: 'var(--d1-series-1, #2a78d6)', dash: null });
		expect(seriesStyle(1).color).toBe('var(--d1-series-2, #eb6834)');
		expect(seriesStyle(1).dash).not.toBeNull();
		expect(seriesStyle(2).color).toBe('var(--d1-series-3, #1baf7a)');
		expect(seriesStyle(2).dash).not.toBe(seriesStyle(1).dash);
		expect(seriesStyle(3).color).toBe(seriesStyle(0).color);
	});
	it('never repeats a colour and dash pair for the first fifteen series', () => {
		const pairs = Array.from({ length: 15 }, (_, i) => `${seriesStyle(i).color}|${seriesStyle(i).dash}`);
		expect(new Set(pairs).size).toBe(15);
	});
});

describe('fmtNum', () => {
	it('is whole from 100, one decimal from 10, up to two below, without trailing zeros', () => {
		expect(fmtNum(1362)).toBe('1362');
		expect(fmtNum(1362.4)).toBe('1362');
		expect(fmtNum(30)).toBe('30');
		expect(fmtNum(30.04)).toBe('30');
		expect(fmtNum(11.84)).toBe('11.8');
		expect(fmtNum(5.8)).toBe('5.8');
		expect(fmtNum(8.18)).toBe('8.18');
		expect(fmtNum(0.15)).toBe('0.15');
		expect(fmtNum(0)).toBe('0');
	});
	it('uses a real minus sign and never prints minus zero', () => {
		expect(fmtNum(-4.5)).toBe('\u22124.5');
		expect(fmtNum(-0.001)).toBe('0');
	});
});

describe('placeTiles', () => {
	it('fills a 2-wide grid in rows', () => {
		const { placements, rows } = placeTiles(['sm', 'sm', 'sm', 'sm', 'sm', 'sm'], 2);
		expect(rows).toBe(3);
		expect(placements[5]).toEqual({ row: 2, col: 1, rowSpan: 1, colSpan: 1 });
	});
	it('gives a wide tile its own row and a tall tile two rows', () => {
		const { placements, rows } = placeTiles(['sm', 'wide', 'tall', 'sm', 'sm'], 2);
		expect(placements[0]).toMatchObject({ row: 0, col: 0 });
		expect(placements[1]).toMatchObject({ row: 1, col: 0, colSpan: 2 });
		expect(placements[2]).toMatchObject({ row: 2, col: 0, rowSpan: 2 });
		expect(placements[3]).toMatchObject({ row: 2, col: 1 });
		expect(placements[4]).toMatchObject({ row: 3, col: 1 });
		expect(rows).toBe(4);
	});
	it('does not backfill the hole a wide tile leaves, like the CSS grid', () => {
		const { placements } = placeTiles(['sm', 'wide', 'sm'], 2);
		expect(placements[2]).toMatchObject({ row: 2, col: 0 });
	});
	it('ignores the spans in one column, and places three across', () => {
		expect(placeTiles(['big', 'tall'], 1).rows).toBe(2);
		expect(placeTiles(['sm', 'sm', 'sm', 'sm', 'sm', 'sm'], 3).rows).toBe(2);
	});
	it('has no rows for no tiles', () => {
		expect(placeTiles([], 2)).toEqual({ placements: [], rows: 0 });
	});
});

describe('hasNoTileBelow', () => {
	const open = (spans: Parameters<typeof placeTiles>[0], cols = 2) => hasNoTileBelow(placeTiles(spans, cols).placements);
	it('is the last row of a full grid', () => {
		expect(open(['sm', 'sm', 'sm', 'sm'])).toEqual([false, false, true, true]);
	});
	it('also marks a tile with an empty cell under it, and not a tall tile beside a short one', () => {
		expect(open(['sm', 'sm', 'sm'])).toEqual([false, true, true]);
		expect(open(['tall', 'sm', 'sm'])).toEqual([true, false, true]);
	});
	it('marks a wide tile only when nothing is under either column', () => {
		expect(open(['wide', 'sm'])).toEqual([false, true]);
	});
});
