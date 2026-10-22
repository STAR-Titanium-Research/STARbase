import { describe, expect, it } from 'vitest';
import { NO_SCALE_REASON, distanceUm, formatArea, formatLength, measureScale, measureText, pixelDistance, polygonArea, previewRatio, selfIntersects, shapeUm, type MeasureShape, type Pt } from './measure';

describe('what Measure needs', () => {
	it('needs both the pixel size and the original width, and no fallback', () => {
		expect(measureScale({ pixel_size_nm: 971.354, image_width_px: 2048 })).toEqual({ pixelSizeNm: 971.354, originalWidthPx: 2048 });
		expect(measureScale({ pixel_size_nm: 971.354 })).toBeNull();
		expect(measureScale({ image_width_px: 2048 })).toBeNull();
		expect(measureScale({ pixel_size_nm: 100, hfw_um: 51.2 })).toEqual({ pixelSizeNm: 100, originalWidthPx: 512 }); // the width follows from the field width and the pixel size
		expect(measureScale({ hfw_um: 50 })).toBeNull(); // no pixel size: no scale
		expect(measureScale({ pixel_size_nm: 0, image_width_px: 2048 })).toBeNull();
		expect(measureScale({ pixel_size_nm: '100', image_width_px: 2048 })).toBeNull();
		expect(measureScale({})).toBeNull();
		expect(measureScale(null)).toBeNull();
		expect(NO_SCALE_REASON).toBe('no scale known for this image');
	});
});

describe('the maths', () => {
	it('is original width over preview width for the ratio', () => {
		expect(previewRatio(2048, 1024)).toBe(2);
		expect(previewRatio(1024, 1024)).toBe(1);
		expect(previewRatio(0, 1024)).toBeNull();
		expect(previewRatio(2048, 0)).toBeNull();
	});

	it('measures a 200 px line at 971.354 nm per pixel as 194.27 µm at ratio 1 and double at ratio 2, within one original pixel', () => {
		const oneOriginalPixelUm = 971.354 / 1000;
		expect(Math.abs(distanceUm(200, 971.354, 1)! - 194.27)).toBeLessThan(oneOriginalPixelUm);
		expect(Math.abs(distanceUm(200, 971.354, 2)! - 388.54)).toBeLessThan(oneOriginalPixelUm);
		expect(distanceUm(200, 971.354, 2)! / distanceUm(200, 971.354, 1)!).toBeCloseTo(2, 10);
	});

	it('is null without a pixel size or a ratio, and for a distance that is not a length', () => {
		expect(distanceUm(200, null, 1)).toBeNull();
		expect(distanceUm(200, 100, null)).toBeNull();
		expect(distanceUm(200, 0, 1)).toBeNull();
		expect(distanceUm(Number.NaN, 100, 1)).toBeNull();
		expect(distanceUm(-1, 100, 1)).toBeNull();
		expect(distanceUm(0, 100, 1)).toBe(0);
	});

	it('takes the straight distance', () => {
		expect(pixelDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
	});

	it('measures a line given as fractions of the picture, on the preview size: a synthetic picture', () => {
		// a 1000 x 800 preview of a 2000 px wide original (ratio 2) at 100 nm per original pixel: a line over a quarter of the width is 250 preview px, 500 original px, 50 µm
		const scale = { pixelSizeNm: 100, originalWidthPx: 2000 };
		const len = (a: Pt, b: Pt, size: { width: number; height: number }, sc: typeof scale | null): number | null => {
			const m = shapeUm({ kind: 'line', a, b }, size, sc);
			return m?.kind === 'line' ? m.length : null;
		};
		const um = len({ x: 0.1, y: 0.5 }, { x: 0.35, y: 0.5 }, { width: 1000, height: 800 }, scale)!;
		expect(Math.abs(um - 50)).toBeLessThan(0.1);
		// the same line drawn at any screen size has the same fractions, so the same length; a diagonal uses the preview's own aspect
		const diag = len({ x: 0, y: 0 }, { x: 0.3, y: 0.375 }, { width: 1000, height: 800 }, scale)!;
		expect(diag).toBeCloseTo((Math.hypot(300, 300) * 2 * 100) / 1000, 6);
		// no scale, or a preview of no size yet: nothing
		expect(len({ x: 0, y: 0 }, { x: 1, y: 0 }, { width: 1000, height: 800 }, null)).toBeNull();
		expect(len({ x: 0, y: 0 }, { x: 1, y: 0 }, { width: 0, height: 0 }, scale)).toBeNull();
	});
});

describe('the length as text', () => {
	it('is in µm from 1 µm up, with two decimals at most', () => {
		expect(formatLength(194.2708)).toBe('194.27 µm');
		expect(formatLength(5)).toBe('5 µm');
		expect(formatLength(1)).toBe('1 µm');
		expect(formatLength(12.5)).toBe('12.5 µm');
		expect(formatLength(1234.5678)).toBe('1,234.57 µm');
	});
	it('is in nm below 1 µm', () => {
		expect(formatLength(0.43)).toBe('430 nm');
		expect(formatLength(0.0085)).toBe('8.5 nm');
		expect(formatLength(0.9994)).toBe('999 nm');
		expect(formatLength(0.9995)).toBe('1 µm'); // never "1,000 nm"
		expect(formatLength(0.9999)).toBe('1 µm');
		expect(formatLength(0)).toBe('0 nm');
	});
	it('is empty for something that is not a length', () => {
		expect(formatLength(Number.NaN)).toBe('');
		expect(formatLength(-3)).toBe('');
	});
});

describe('the area as text', () => {
	it('is in µm² below 1 mm², with thousands separators and fewer decimals as it grows', () => {
		expect(formatArea(35299.17)).toBe('35,299 µm²');
		expect(formatArea(12400)).toBe('12,400 µm²');
		expect(formatArea(250.4)).toBe('250 µm²');
		expect(formatArea(42.46)).toBe('42.5 µm²');
		expect(formatArea(3.14159)).toBe('3.14 µm²');
		expect(formatArea(0.0042)).toBe('0 µm²'); // never nm²
		expect(formatArea(999999)).toBe('999,999 µm²');
	});
	it('is in mm² from 1 mm² (1,000,000 µm²) up', () => {
		expect(formatArea(1e6)).toBe('1 mm²');
		expect(formatArea(1.25e6)).toBe('1.25 mm²');
		expect(formatArea(12.5e6)).toBe('12.5 mm²');
	});
	it('is empty for something that is not an area', () => {
		expect(formatArea(Number.NaN)).toBe('');
		expect(formatArea(-1)).toBe('');
	});
});

describe('measuring a shape', () => {
	// a 1000 x 800 preview; the original is as wide (ratio 1), so one preview pixel is 971.354 nm
	const size = { width: 1000, height: 800 };
	const scale = { pixelSizeNm: 971.354, originalWidthPx: 1000 };
	const um = 0.971354; // µm per preview pixel
	const f = (x: number, y: number): Pt => ({ x: x / size.width, y: y / size.height }); // preview pixels as fractions
	const rect = (x: number, y: number, w: number, h: number): Pt[] => [f(x, y), f(x + w, y), f(x + w, y + h), f(x, y + h)];
	const poly = (pts: Pt[]): MeasureShape => ({ kind: 'polygon', pts, closed: true });

	it('line: 200 px at 971.354 nm per pixel and ratio 1 is 194.27 µm', () => {
		const m = shapeUm({ kind: 'line', a: f(100, 100), b: f(300, 100) }, size, scale)!;
		if (m.kind !== 'line') throw new Error('not a line');
		expect(m.length).toBeCloseTo(194.2708, 4);
		expect(formatLength(m.length)).toBe('194.27 µm');
		expect(measureText(m)).toBe('194.27 µm');
	});

	it('circle: a radius of 100 preview px has the diameter 2r, the circumference 2 pi r and the area pi r squared', () => {
		const m = shapeUm({ kind: 'circle', c: f(500, 400), r: f(600, 400) }, size, scale)!;
		if (m.kind !== 'circle') throw new Error('not a circle');
		const r = 100 * um;
		expect(m.radius).toBeCloseTo(r, 9);
		expect(m.diameter).toBeCloseTo(2 * r, 9);
		expect(m.circumference).toBeCloseTo(2 * Math.PI * r, 9);
		expect(m.area).toBeCloseTo(Math.PI * r * r, 6);
		expect(measureText(m)).toBe(`Ø 194.27 µm · area ${formatArea(Math.PI * r * r)}`);
		// the rim point can be anywhere on the rim: a point straight below the centre gives the same circle
		const below = shapeUm({ kind: 'circle', c: f(500, 400), r: f(500, 500) }, size, scale)!;
		expect(below.kind === 'circle' && below.area).toBeCloseTo(m.area, 6);
	});

	it('polygon: a 100 x 50 px rectangle has the area 100 x 50 x (px size) squared in µm², and its perimeter', () => {
		const m = shapeUm(poly(rect(200, 200, 100, 50)), size, scale)!;
		if (m.kind !== 'polygon') throw new Error('not a polygon');
		expect(m.area).toBeCloseTo(100 * 50 * um * um, 6);
		expect(m.perimeter).toBeCloseTo(300 * um, 9);
		expect(m.selfIntersects).toBe(false);
		expect(measureText(m)).toBe(`area ${formatArea(100 * 50 * um * um)} · perimeter ${formatLength(300 * um)}`);
		expect(measureText(m)).toBe('area 4,718 µm² · perimeter 291.41 µm');
	});

	it('polygon: the same area whichever way round the corners are clicked, and from any starting corner', () => {
		const pts = rect(200, 200, 100, 50);
		const a = shapeUm(poly(pts), size, scale)!;
		const b = shapeUm(poly([...pts].reverse()), size, scale)!;
		const c = shapeUm(poly([pts[2], pts[3], pts[0], pts[1]]), size, scale)!;
		if (a.kind !== 'polygon' || b.kind !== 'polygon' || c.kind !== 'polygon') throw new Error('not polygons');
		expect(b.area).toBeCloseTo(a.area, 9);
		expect(c.area).toBeCloseTo(a.area, 9);
		expect(b.perimeter).toBeCloseTo(a.perimeter, 9);
		expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }])).toBe(6);
		expect(polygonArea([{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 4, y: 0 }])).toBe(6);
	});

	it('polygon with fewer than 3 corners is null', () => {
		expect(shapeUm(poly([]), size, scale)).toBeNull();
		expect(shapeUm(poly([f(1, 1)]), size, scale)).toBeNull();
		expect(shapeUm(poly([f(1, 1), f(50, 50)]), size, scale)).toBeNull();
		expect(shapeUm(poly(rect(0, 0, 10, 10).slice(0, 3)), size, scale)).not.toBeNull();
	});

	it('the ratio scales lengths and squares areas: an original twice as wide as the preview', () => {
		const doubled = { pixelSizeNm: 971.354, originalWidthPx: 2000 };
		const one = shapeUm(poly(rect(200, 200, 100, 50)), size, scale)!;
		const two = shapeUm(poly(rect(200, 200, 100, 50)), size, doubled)!;
		if (one.kind !== 'polygon' || two.kind !== 'polygon') throw new Error('not polygons');
		expect(two.area).toBeCloseTo(one.area * 4, 6);
		expect(two.perimeter).toBeCloseTo(one.perimeter * 2, 9);
		const c1 = shapeUm({ kind: 'circle', c: f(500, 400), r: f(600, 400) }, size, scale)!;
		const c2 = shapeUm({ kind: 'circle', c: f(500, 400), r: f(600, 400) }, size, doubled)!;
		if (c1.kind !== 'circle' || c2.kind !== 'circle') throw new Error('not circles');
		expect(c2.area / c1.area).toBeCloseTo(4, 9);
		const l1 = shapeUm({ kind: 'line', a: f(0, 0), b: f(100, 0) }, size, scale)!;
		const l2 = shapeUm({ kind: 'line', a: f(0, 0), b: f(100, 0) }, size, doubled)!;
		if (l1.kind !== 'line' || l2.kind !== 'line') throw new Error('not lines');
		expect(l2.length / l1.length).toBeCloseTo(2, 9);
	});

	it('uses the preview own size: the same fractions on a smaller preview of the same original read the same µm', () => {
		const original = { pixelSizeNm: 100, originalWidthPx: 2000 };
		const half = { kind: 'line', a: { x: 0, y: 0 }, b: { x: 0.5, y: 0 } } as const;
		const a = shapeUm(half, { width: 1000, height: 800 }, original)!;
		const b = shapeUm(half, { width: 500, height: 400 }, original)!;
		if (a.kind !== 'line' || b.kind !== 'line') throw new Error('not lines');
		expect(a.length).toBeCloseTo(b.length, 9);
		expect(a.length).toBeCloseTo(100, 9); // half of 2000 px at 100 nm
	});

	it('says nothing without a scale or a size', () => {
		const line: MeasureShape = { kind: 'line', a: f(0, 0), b: f(100, 0) };
		expect(shapeUm(line, size, null)).toBeNull();
		expect(shapeUm(line, { width: 0, height: 0 }, scale)).toBeNull();
		expect(measureText(null)).toBe('');
	});

	it('flags sides that cross ("check the outline") and not a plain or concave polygon', () => {
		const bowTie = [f(0, 0), f(100, 100), f(100, 0), f(0, 100)];
		expect(selfIntersects(bowTie)).toBe(true);
		expect(selfIntersects(rect(0, 0, 100, 50))).toBe(false);
		expect(selfIntersects([f(0, 0), f(100, 0), f(50, 30), f(100, 100), f(0, 100)])).toBe(false); // concave, not crossing
		expect(selfIntersects([f(0, 0), f(10, 0), f(5, 5)])).toBe(false); // a triangle cannot
		const m = shapeUm(poly(bowTie), size, scale)!;
		expect(m.kind === 'polygon' && m.selfIntersects).toBe(true);
		expect(measureText(m)).toMatch(/ · check the outline$/);
		expect(measureText(shapeUm(poly(rect(0, 0, 100, 50)), size, scale))).not.toMatch(/check the outline/);
	});

	it('a closed polygon with its corners on one line has no area but a perimeter, and says both; with all corners on one spot, nothing', () => {
		const flat = shapeUm(poly([f(0, 0), f(100, 0), f(200, 0)]), size, scale)!;
		if (flat.kind !== 'polygon') throw new Error('not a polygon');
		expect(flat.area).toBe(0);
		expect(measureText(flat)).toBe(`area 0 µm² · perimeter ${formatLength(400 * um)}`);
		expect(measureText(shapeUm(poly([f(5, 5), f(5, 5), f(5, 5)]), size, scale))).toBe('');
	});

	it('has no words for a shape with no size yet', () => {
		expect(measureText(shapeUm({ kind: 'line', a: f(5, 5), b: f(5, 5) }, size, scale))).toBe('');
		expect(measureText(shapeUm({ kind: 'circle', c: f(5, 5), r: f(5, 5) }, size, scale))).toBe('');
	});
});
