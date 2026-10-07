// Covers the two pieces of ColorScaleEditor.vue's handle geometry that aren't obvious by reading:
// which handle a click grabs when several share an x position, and where a marker sits on the
// distribution curve.
import { describe, expect, it } from 'vitest';
import { CIRCLE_BAND_PX, curveHeightFrac, handleDragPatch, pickHandle, type HandleGeom } from './scaleHandles';
import { histogramFrom } from './histogram';
import { applyParams, defaultScale } from './colorScale';

const W = 400;
const H = 90;
// The default state of a freshly seeded scale: satMin and dispMin both pin to the left edge,
// satMax and dispMax both to the right. Every handle is co-located with another one. The flags'
// dots sit low here (empty tails), the circles are centred at H/2.
const SEEDED: HandleGeom[] = [
	{ key: 'satMin', style: 'flag', pct: 0, dotY: H - 3 },
	{ key: 'satMax', style: 'flag', pct: 100, dotY: H - 3 },
	{ key: 'dispMin', style: 'circle', pct: 0 },
	{ key: 'dispMax', style: 'circle', pct: 100 },
];

describe('pickHandle', () => {
	it('returns null when the pointer is nowhere near a handle', () => {
		expect(pickHandle(SEEDED, W / 2, 40, W, H)).toBeNull();
	});

	it('grabs the saturation flag by its triangle at the top of a co-located pair', () => {
		expect(pickHandle(SEEDED, 0, 2, W, H)).toBe('satMin');
		expect(pickHandle(SEEDED, W, 2, W, H)).toBe('satMax');
	});

	it('grabs the displayed-range circle at mid-height, where its wall-edge marker sits', () => {
		expect(pickHandle(SEEDED, 0, H / 2, W, H)).toBe('dispMin');
		expect(pickHandle(SEEDED, W, H / 2, W, H)).toBe('dispMax');
	});

	it('grabs the saturation flag near its curve-riding dot, not just its triangle', () => {
		expect(pickHandle(SEEDED, 0, H - 4, W, H)).toBe('satMin');
		expect(pickHandle(SEEDED, W, H - 4, W, H)).toBe('satMax');
	});

	// A nearest-anchor tie-break handed the circle everything from a quarter height down, so the
	// flag's full-height stem stopped responding wherever the two handles shared an x -- which is
	// most of the time. Only the circle's own band belongs to it.
	it('keeps the flag grabbable along its stem, just outside the circle band', () => {
		const justOutside = H / 2 + CIRCLE_BAND_PX + 2;
		expect(pickHandle(SEEDED, W, justOutside, W, H)).toBe('satMax');
		expect(pickHandle(SEEDED, W, H / 2 - CIRCLE_BAND_PX - 2, W, H)).toBe('satMax');
	});

	it('gives the circle the band immediately around mid-height', () => {
		expect(pickHandle(SEEDED, W, H / 2 + CIRCLE_BAND_PX - 1, W, H)).toBe('dispMax');
		expect(pickHandle(SEEDED, W, H / 2 - CIRCLE_BAND_PX + 1, W, H)).toBe('dispMax');
	});

	// The bug this file exists for: with a tie-break that always preferred saturation, a freshly
	// seeded scale (where every displayed handle shares an x with a saturation one) left the
	// displayed range impossible to drag at all.
	it('leaves every handle reachable from a freshly seeded scale', () => {
		const reachable = new Set<string | null>([
			pickHandle(SEEDED, 0, 2, W, H), pickHandle(SEEDED, 0, H / 2, W, H),
			pickHandle(SEEDED, W, 2, W, H), pickHandle(SEEDED, W, H / 2, W, H),
		]);
		expect(reachable).toEqual(new Set(['satMin', 'satMax', 'dispMin', 'dispMax']));
	});

	it('picks the nearest handle by x before any vertical tie-breaking applies', () => {
		const spread: HandleGeom[] = [
			{ key: 'satMin', style: 'flag', pct: 10, dotY: 0 },
			{ key: 'dispMin', style: 'circle', pct: 50 },
		];
		// Right on top of the circle's x but at the very top -- x still wins, so it's the circle.
		expect(pickHandle(spread, 200, H / 2, W, H)).toBe('dispMin');
		expect(pickHandle(spread, 40, 0, W, H)).toBe('satMin');
	});

	it('treats sub-pixel position differences as a tie rather than a near-miss', () => {
		const rounded: HandleGeom[] = [
			{ key: 'satMax', style: 'flag', pct: 50, dotY: H - 3 },
			{ key: 'dispMax', style: 'circle', pct: 50.2 },   // ~0.8px apart at W=400
		];
		expect(pickHandle(rounded, 200, H / 2, W, H)).toBe('dispMax');
		expect(pickHandle(rounded, 200, 2, W, H)).toBe('satMax');
	});

	it('splits coincident saturation flags by pointer side so satMax stays draggable', () => {
		const collapsed: HandleGeom[] = [
			{ key: 'satMin', style: 'flag', pct: 50, dotY: H - 3 },
			{ key: 'satMax', style: 'flag', pct: 50, dotY: H - 3 },
		];
		expect(pickHandle(collapsed, 203, 2, W, H)).toBe('satMax');
		expect(pickHandle(collapsed, 197, 2, W, H)).toBe('satMin');
		expect(pickHandle(collapsed, 200, 2, W, H, 'satMin')).toBe('satMin');
		expect(pickHandle(collapsed, 200, 2, W, H)).toBe('satMax');
	});
});

describe('pickHandle: coincident ends can always be pulled apart (#78)', () => {
	// An open displayed range pinned to the same edge, or a collapsed one, puts both circles on one x.
	const circles: HandleGeom[] = [
		{ key: 'dispMin', style: 'circle', pct: 50 },
		{ key: 'dispMax', style: 'circle', pct: 50 },
	];
	it('splits coincident displayed-range circles by pointer side', () => {
		expect(pickHandle(circles, 204, H / 2, W, H)).toBe('dispMax');
		expect(pickHandle(circles, 196, H / 2, W, H)).toBe('dispMin');
	});
	it('on an exact tie keeps the end last dragged, else the max end', () => {
		expect(pickHandle(circles, 200, H / 2, W, H, 'dispMin')).toBe('dispMin');
		expect(pickHandle(circles, 200, H / 2, W, H)).toBe('dispMax');
	});
	it('still splits flags when circles are co-located too', () => {
		const all: HandleGeom[] = [
			{ key: 'satMin', style: 'flag', pct: 50, dotY: H - 3 }, { key: 'satMax', style: 'flag', pct: 50, dotY: H - 3 },
			...circles,
		];
		expect(pickHandle(all, 204, 2, W, H)).toBe('satMax');
		expect(pickHandle(all, 196, 2, W, H)).toBe('satMin');
		expect(pickHandle(all, 196, H / 2, W, H)).toBe('dispMin');
	});
});

describe('handleDragPatch: shaped range clamps (always-show-zero)', () => {
	const EPS = 1e-6;
	// Data 25..35; always-show-zero shapes it to 0..35.
	const zero = applyParams({ ...defaultScale(25, 35), alwaysShowZero: true }, 25, 35);

	it('lets satMax go below the base minimum, anywhere the shaped range allows', () => {
		expect([zero.satMin, zero.satMax]).toEqual([0, 35]);
		const dragged = applyParams({ ...zero, ...handleDragPatch(zero, 'satMax', 10, EPS) }, 25, 35);
		expect(dragged.satMax).toBe(10);   // used to stick at 25, the base minimum
		expect(dragged.satMin).toBe(0);
	});
	it('still keeps satMax above the shaped minimum', () => {
		const p = handleDragPatch(zero, 'satMax', -5, EPS);
		expect(p.satMax).toBeCloseTo(0 + EPS, 9);
	});
	it('unticking afterwards keeps a valid range around the dragged end', () => {
		const dragged = applyParams({ ...zero, ...handleDragPatch(zero, 'satMax', 10, EPS) }, 25, 35);
		const off = applyParams({ ...dragged, alwaysShowZero: false }, 25, 35);
		expect(off.satMax).toBe(10);
		expect(off.satMax).toBeGreaterThan(off.satMin);
	});
	it('satMin dragged above the base maximum slides the base the same way', () => {
		const neg = applyParams({ ...defaultScale(-35, -25), alwaysShowZero: true }, -35, -25);
		expect([neg.satMin, neg.satMax]).toEqual([-35, 0]);
		const dragged = applyParams({ ...neg, ...handleDragPatch(neg, 'satMin', -10, EPS) }, -35, -25);
		expect(dragged.satMin).toBe(-10);
		expect(dragged.satMax).toBe(0);
	});
});

describe('handleDragPatch', () => {
	const EPS = 1e-6;
	const linear = { ...defaultScale(25, 35), satMin: 25, satMax: 35 };
	const symmetric = applyParams({ ...linear, symmetrical: true }, 25, 35);

	it('moves only the dragged end when not symmetrical', () => {
		// (the base range moves with it -- see ColorScale.baseMin)
		expect(handleDragPatch(linear, 'satMax', 30, EPS)).toEqual({ satMax: 30, baseMax: 30 });
		expect(handleDragPatch(linear, 'satMin', 27, EPS)).toEqual({ satMin: 27, baseMin: 27 });
	});

	it('keeps the dragged end on its own side of the other', () => {
		// Dragging satMax below satMin must not invert the range.
		expect(handleDragPatch(linear, 'satMax', 10, EPS).satMax).toBeCloseTo(25 + EPS, 9);
		expect(handleDragPatch(linear, 'satMin', 99, EPS).satMin).toBeCloseTo(35 - EPS, 9);
	});

	// The reported bug: under `symmetrical` the saturation handles appeared frozen.
	it('mirrors both saturation ends under symmetrical', () => {
		expect(symmetric.satMin).toBe(-35);
		expect(symmetric.satMax).toBe(35);
		expect(handleDragPatch(symmetric, 'satMax', 30, EPS)).toMatchObject({ satMin: -30, satMax: 30 });
		// Dragging the NEGATIVE end works off its magnitude, so it is equally effective.
		expect(handleDragPatch(symmetric, 'satMin', -20, EPS)).toMatchObject({ satMin: -20, satMax: 20 });
	});

	it('drags edit the base range, so unticking symmetrical keeps the drag', () => {
		// Data 25..35, symmetrical on (-35..35), satMax dragged to 30.
		const dragged = applyParams({ ...symmetric, ...handleDragPatch(symmetric, 'satMax', 30, EPS) }, 25, 35);
		expect([dragged.satMin, dragged.satMax]).toEqual([-30, 30]);
		const off = applyParams({ ...dragged, symmetrical: false }, 25, 35);
		expect([off.satMin, off.satMax]).toEqual([25, 30]);
	});

	it('a drag that crosses the base range re-bases on the mirrored range', () => {
		const dragged = applyParams({ ...symmetric, ...handleDragPatch(symmetric, 'satMax', 20, EPS) }, 25, 35);
		expect([dragged.satMin, dragged.satMax]).toEqual([-20, 20]);
		const off = applyParams({ ...dragged, symmetrical: false }, 25, 35);
		expect([off.satMin, off.satMax]).toEqual([-20, 20]);
	});

	it('survives applyParams under symmetrical instead of snapping back', () => {
		// This is what actually broke: setting only satMax left satMin holding the larger
		// magnitude, so applyParams recomputed M from it and undid the drag on the same frame.
		const patched = applyParams({ ...symmetric, ...handleDragPatch(symmetric, 'satMax', 30, EPS) }, 25, 35);
		expect(patched.satMax).toBe(30);
		expect(patched.satMin).toBe(-30);

		const naive = applyParams({ ...symmetric, satMax: 30 }, 25, 35);
		expect(naive.satMax).toBe(35);   // the old behaviour, pinned by satMin's magnitude
	});

	it('leaves the displayed range alone when a saturation handle is dragged', () => {
		const patch = handleDragPatch(symmetric, 'satMax', 30, EPS);
		expect(patch.dispMin).toBeUndefined();
		expect(patch.dispMax).toBeUndefined();
	});

	it('moves displayed handles independently of symmetrical', () => {
		const s = { ...symmetric, dispMin: -10, dispMax: 10 };
		expect(handleDragPatch(s, 'dispMax', 5, EPS)).toEqual({ dispMax: 5 });
		expect(handleDragPatch(s, 'dispMin', -5, EPS)).toEqual({ dispMin: -5 });
	});
});

describe('curveHeightFrac', () => {
	const flat = histogramFrom(Float32Array.from({ length: 100 }, () => 5), 100, 0, 10, 10);

	it('is 0 with no histogram, so a marker falls back to the axis', () => {
		expect(curveHeightFrac(null, 5)).toBe(0);
		expect(curveHeightFrac(undefined, 5)).toBe(0);
	});

	it('is 0 for a NaN value rather than propagating it into a style offset', () => {
		expect(curveHeightFrac(flat, NaN)).toBe(0);
	});

	it('peaks at the populated bin CENTRE and drops to 0 in the empty tails', () => {
		// Every sample is 5.0, which lands in the bin spanning [5, 6) -- so the peak is at that
		// bin's CENTRE, 5.5, not at 5.0.
		expect(curveHeightFrac(flat, 5.5)).toBeCloseTo(1, 5);
		expect(curveHeightFrac(flat, 0)).toBe(0);
		expect(curveHeightFrac(flat, 10)).toBe(0);
	});

	it('interpolates between bin centres rather than snapping to a bin', () => {
		// 5.0 is halfway between the empty bin centred at 4.5 and the full one centred at 5.5.
		expect(curveHeightFrac(flat, 5)).toBeCloseTo(0.5, 5);
	});

	it('stays within 0..1 for values outside the histogram range', () => {
		for (const v of [-1e6, 1e6]) {
			const y = curveHeightFrac(flat, v);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(1);
		}
	});
});
