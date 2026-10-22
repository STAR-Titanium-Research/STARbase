import { describe, expect, it } from 'vitest';
import type { SavedMeasurement } from './inboxApi';
import { shapeUm, type MeasureScale, type MeasureShape } from './measure';
import {
	CSV_HEADER, csvText, measurementRows, measurementsToCsv, orderMeasurements, plain, rowText, savedMeasure, savedToShape, shapeToNew, valueText,
} from './measurements';

// A 1000 px wide original at 100 nm per pixel (so 1 original pixel = 0.1 µm), shown by a preview of 256 x 192.
const SCALE: MeasureScale = { pixelSizeNm: 100, originalWidthPx: 1000 };
const PREVIEW = { width: 256, height: 192 };

let n = 0;
const saved = (over: Partial<SavedMeasurement> = {}): SavedMeasurement => {
	n += 1;
	return {
		measurement_id: `m${String(n).padStart(3, '0')}`, kind: 'line', points: [{ x: 0, y: 0 }, { x: 2120, y: 0 }], label: '', created_at: `2026-10-22T10:00:${String(n).padStart(2, '0')}.000Z`,
		author_name: 'Ann Lee', can_edit: true, ...over,
	};
};

describe('drawn shape <-> stored shape (original pixels)', () => {
	const DRAFTS: Record<string, MeasureShape> = {
		line: { kind: 'line', a: { x: 0.1, y: 0.2 }, b: { x: 0.6, y: 0.7 } },
		circle: { kind: 'circle', c: { x: 0.5, y: 0.5 }, r: { x: 0.7, y: 0.5 } },
		polygon: { kind: 'polygon', pts: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.2 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.8 }], closed: true },
	};

	it('stores corners in pixels of the ORIGINAL: a fraction of the width x the original width, a fraction of the height x width / height', () => {
		expect(shapeToNew(DRAFTS.line, PREVIEW, SCALE)).toEqual({ kind: 'line', points: [{ x: 100, y: 150 }, { x: 600, y: 525 }] });
		// y: 0.2 of the preview's height is 0.2 x 192 = 38.4 preview pixels = 38.4 x (1000 / 256) = 150 original pixels
		expect(shapeToNew(DRAFTS.circle, PREVIEW, SCALE)).toEqual({ kind: 'circle', points: [{ x: 500, y: 375 }, { x: 700, y: 375 }] });
		const poly = shapeToNew(DRAFTS.polygon, PREVIEW, SCALE)!;
		expect(poly.kind).toBe('polygon');
		expect(poly.points).toHaveLength(4);
		expect(poly.points[0]).toEqual({ x: 100, y: 75 });
	});

	it('gives the same corners whatever size the preview is drawn at (a bigger preview of the same picture has the same fractions)', () => {
		const a = shapeToNew(DRAFTS.polygon, PREVIEW, SCALE)!;
		const b = shapeToNew(DRAFTS.polygon, { width: 1024, height: 768 }, SCALE)!;
		expect(b.points).toEqual(a.points);
	});

	it('comes back as the same fractions', () => {
		for (const shape of Object.values(DRAFTS)) {
			const stored = shapeToNew(shape, PREVIEW, SCALE)!;
			const back = savedToShape(stored, PREVIEW, SCALE)!;
			expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(shape)));
		}
	});

	it('is nothing without a scale or a size, and for a polygon that is not finished', () => {
		expect(shapeToNew(DRAFTS.line, PREVIEW, null)).toBeNull();
		expect(shapeToNew(DRAFTS.line, null, SCALE)).toBeNull();
		expect(shapeToNew(DRAFTS.line, { width: 0, height: 192 }, SCALE)).toBeNull();
		expect(shapeToNew({ kind: 'polygon', pts: DRAFTS.polygon.kind === 'polygon' ? DRAFTS.polygon.pts : [], closed: false }, PREVIEW, SCALE)).toBeNull();
		expect(shapeToNew({ kind: 'polygon', pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: true }, PREVIEW, SCALE)).toBeNull();
		expect(savedToShape(saved(), PREVIEW, null)).toBeNull();
		expect(savedToShape(saved({ kind: 'polygon' }), PREVIEW, SCALE)).toBeNull(); // two points are not a polygon
		expect(savedToShape(saved({ kind: 'circle', points: [{ x: 1, y: 1 }] }), PREVIEW, SCALE)).toBeNull();
	});

	it('measuring a saved shape (from its original pixels) is measuring the draft it came from (on the preview), to rounding', () => {
		for (const [name, shape] of Object.entries(DRAFTS)) {
			const want = shapeUm(shape, PREVIEW, SCALE)!;
			const got = savedMeasure(shapeToNew(shape, PREVIEW, SCALE)!, SCALE)!;
			expect(got.kind, name).toBe(want.kind);
			const wantNums = want as unknown as Record<string, unknown>;
			const gotNums = got as unknown as Record<string, unknown>;
			for (const key of Object.keys(wantNums)) {
				if (key === 'kind' || key === 'selfIntersects') continue;
				expect(gotNums[key] as number, `${name}.${key}`).toBeCloseTo(wantNums[key] as number, 6);
			}
		}
	});

	it('re-measures when the pixel size is corrected: nothing but pixels is stored', () => {
		const m = saved({ points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] });
		expect((savedMeasure(m, SCALE) as { length: number }).length).toBeCloseTo(100, 9); // 1000 px x 0.1 µm
		expect((savedMeasure(m, { ...SCALE, pixelSizeNm: 50 }) as { length: number }).length).toBeCloseTo(50, 9);
		expect(savedMeasure(m, null)).toBeNull();
	});

	it('a circle is two points: the centre and one on its rim; a polygon\'s area is the same whichever way round', () => {
		const c = savedMeasure({ kind: 'circle', points: [{ x: 100, y: 100 }, { x: 400, y: 100 }] }, SCALE) as { diameter: number; radius: number; area: number; circumference: number };
		expect(c.radius).toBeCloseTo(30, 9);
		expect(c.diameter).toBeCloseTo(60, 9);
		expect(c.area).toBeCloseTo(Math.PI * 900, 6);
		expect(c.circumference).toBeCloseTo(2 * Math.PI * 30, 6);
		const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
		const a = savedMeasure({ kind: 'polygon', points: square }, SCALE) as { area: number; perimeter: number };
		const b = savedMeasure({ kind: 'polygon', points: [...square].reverse() }, SCALE) as { area: number };
		expect(a.area).toBeCloseTo(100, 9); // 10 µm x 10 µm
		expect(a.perimeter).toBeCloseTo(40, 9);
		expect(b.area).toBeCloseTo(a.area, 9);
	});
});

describe('the rows', () => {
	it('are numbered in saving order, whatever order they arrive in, and say "1 Line 212 µm", "2 Circle Ø 88 µm", "3 Polygon 12,400 µm²"', () => {
		const line = saved({ points: [{ x: 0, y: 0 }, { x: 2120, y: 0 }] }); // 212 µm
		const circle = saved({ kind: 'circle', points: [{ x: 0, y: 0 }, { x: 440, y: 0 }] }); // radius 44 µm: Ø 88 µm
		const poly = saved({ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1240, y: 0 }, { x: 1240, y: 1000 }, { x: 0, y: 1000 }] }); // 124 x 100 µm = 12,400 µm²
		const rows = measurementRows([poly, line, circle], SCALE);
		expect(rows.map((r) => r.id)).toEqual([line.measurement_id, circle.measurement_id, poly.measurement_id]);
		expect(rows.map(rowText)).toEqual(['1 Line 212 µm', '2 Circle Ø 88 µm', '3 Polygon 12,400 µm²']);
		expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
	});

	it('use the person\'s label for the name when there is one, the kind otherwise; a blank-only label is no label', () => {
		const rows = measurementRows([saved({ label: 'grain A' }), saved({ label: '' }), saved({ kind: 'circle', points: [{ x: 0, y: 0 }, { x: 440, y: 0 }], label: 'pore' })], SCALE);
		expect(rows.map(rowText)).toEqual(['1 grain A 212 µm', '2 Line 212 µm', '3 pore Ø 88 µm']);
		expect(rows.map((r) => r.label)).toEqual(['grain A', '', 'pore']);
	});

	it('order oldest first and break a tie by id (the numbering never jumps between reloads)', () => {
		const t = '2026-10-22T10:00:00.000Z';
		const a = saved({ created_at: t, measurement_id: 'b' });
		const b = saved({ created_at: t, measurement_id: 'a' });
		const c = saved({ created_at: '2026-10-21T10:00:00.000Z' });
		expect(orderMeasurements([a, b, c]).map((m) => m.measurement_id)).toEqual([c.measurement_id, 'a', 'b']);
		const list = [a, b];
		orderMeasurements(list);
		expect(list.map((m) => m.measurement_id)).toEqual(['b', 'a']); // the input is not changed
	});

	it('carry what the row needs: can_edit, the author, and no value without a scale', () => {
		const [r] = measurementRows([saved({ can_edit: false, author_name: null })], SCALE);
		expect(r.canEdit).toBe(false);
		expect(r.author).toBeNull();
		const [none] = measurementRows([saved()], null);
		expect(none.value).toBe('');
		expect(none.measure).toBeNull();
		expect(rowText(none)).toBe('1 Line');
	});

	it('words each kind\'s size, in µm, nm and mm', () => {
		expect(valueText({ kind: 'line', length: 0.43 })).toBe('430 nm');
		expect(valueText({ kind: 'line', length: 212.004 })).toBe('212 µm');
		expect(valueText({ kind: 'circle', diameter: 88, radius: 44, circumference: 276, area: 6082 })).toBe('Ø 88 µm');
		expect(valueText({ kind: 'polygon', area: 1_250_000, perimeter: 5000, selfIntersects: false })).toBe('1.25 mm²');
		expect(valueText(null)).toBe('');
	});
});

describe('CSV', () => {
	const rowsFor = (list: SavedMeasurement[]) => measurementRows(list, SCALE);

	it('is a header and a row per shape, with the sizes that apply to the kind and the rest empty', () => {
		const csv = measurementsToCsv(rowsFor([
			saved({ points: [{ x: 0, y: 0 }, { x: 2120, y: 0 }], label: 'grain A' }),
			saved({ kind: 'circle', points: [{ x: 0, y: 0 }, { x: 440, y: 0 }] }),
			saved({ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1240, y: 0 }, { x: 1240, y: 1000 }, { x: 0, y: 1000 }] }),
		]));
		const lines = csv.trimEnd().split('\n');
		expect(csv.endsWith('\n')).toBe(true);
		expect(lines[0]).toBe('n,label,kind,length_um,diameter_um,perimeter_um,area_um2');
		expect(lines[0]).toBe(CSV_HEADER.join(','));
		expect(lines[1]).toBe('1,grain A,line,212,,,');
		expect(lines[2]).toBe('2,,circle,,88,276.46,6082.12');
		expect(lines[3]).toBe('3,,polygon,,,448,12400');
	});

	it('writes plain decimals: no thousands separator, no unit, no exponent, 6 significant digits', () => {
		expect(plain(12400)).toBe('12400');
		expect(plain(12400.4)).toBe('12400.4');
		expect(plain(0.0085)).toBe('0.0085');
		expect(plain(1234567.89)).toBe('1234570');
		expect(plain(0.0000001234)).toBe('0.0000001234'); // never 1.234e-7
		expect(plain(212.00000001)).toBe('212');
		expect(plain(0)).toBe('0');
		expect(plain(NaN)).toBe('');
		const csv = measurementsToCsv(rowsFor([saved({ kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 12400, y: 0 }, { x: 12400, y: 10000 }, { x: 0, y: 10000 }] })]));
		expect(csv.split('\n')[1]).toBe('1,,polygon,,,4480,1240000');
		expect(csv).not.toMatch(/µ|"|e\+/);
	});

	it('quotes a label with a comma, a quote or a line break, and does not let a label run as a formula', () => {
		expect(csvText('plain')).toBe('plain');
		expect(csvText('a,b')).toBe('"a,b"');
		expect(csvText('say "hi"')).toBe('"say ""hi"""');
		expect(csvText('two\nlines')).toBe('"two\nlines"');
		expect(csvText('=SUM(A1)')).toBe("'=SUM(A1)");
		expect(csvText('-5')).toBe("'-5");
		expect(csvText('@x')).toBe("'@x");
		expect(csvText('+1,2')).toBe('"\'+1,2"');
		const csv = measurementsToCsv(rowsFor([saved({ label: 'grain, "A"' })]));
		expect(csv.split('\n')[1]).toBe('1,"grain, ""A""",line,212,,,');
	});

	it('is the header alone for no shapes', () => {
		expect(measurementsToCsv([])).toBe('n,label,kind,length_um,diameter_um,perimeter_um,area_um2\n');
	});

	it('leaves the sizes empty (not zero) for a shape that cannot be measured', () => {
		const [row] = measurementRows([saved()], null);
		expect(measurementsToCsv([row]).split('\n')[1]).toBe('1,,line,,,,');
	});
});
