import { describe, expect, it } from 'vitest';
import { resolveInsertGeometry, insertOutline } from '@d1/ui';
import { buildReferenceMark } from './insertMesh';
import { buildTipGeometry, TIP_SIDE_MM } from './tipMesh';
import { SceneMaterials } from './materials';
import { luminance, type Palette, type Rgba } from './themePalette';

const rgba = (v: number): Rgba => ({ r: v, g: v, b: v, a: 1 });
const palette = (dark: boolean): Palette => {
	const p = {} as Palette;
	for (const k of ['tile', 'tray', 'ink', 'body', 'mark', 'ok', 'warn', 'dim', 'accent', 'pick', 'tipPcd', 'tipCbn'] as const) p[k] = rgba(0.5);
	p.tile = rgba(dark ? 0.05 : 0.95);
	p.body = rgba(dark ? 0.2 : 0.3);
	p.tipPcd = rgba(dark ? 0.8 : 0.85);
	p.tipCbn = { r: 0.55, g: 0.45, b: 0.3, a: 1 };
	return p;
};

const geomOf = (extra: Record<string, unknown>, iso = 'CCGW 09T3 04') => {
	const g = resolveInsertGeometry({ iso_designation: iso, ...extra });
	return { g, o: insertOutline(g) };
};
const bounds = (geo: ReturnType<typeof buildTipGeometry>) => {
	geo!.computeBoundingBox();
	return geo!.boundingBox!;
};

describe('buildTipGeometry', () => {
	it('is null for an insert with no tip', () => {
		const { g, o } = geomOf({ edge_count: 1 });
		expect(buildTipGeometry(g, o)).toBeNull();
	});

	it('draws one pad on the single cutting corner of a one-edge PCD insert, at corner A (-z, up on screen)', () => {
		const { g, o } = geomOf({ edge_count: 1, substrate: 'PCD' });
		const geo = buildTipGeometry(g, o)!;
		expect(geo).not.toBeNull();
		const b = bounds(geo);
		expect(b.max.z).toBeLessThan(0); // corner 0 points to -z, nothing on the other side
		expect(b.min.z).toBeLessThan(-g.icMm * 0.3);
		expect(b.min.x).toBeLessThan(0);
		expect(b.max.x).toBeGreaterThan(0);
	});

	it('is flush with the top face: thin, and no higher than a hair above it', () => {
		const { g, o } = geomOf({ edge_count: 1, substrate: 'PCD' });
		const b = bounds(buildTipGeometry(g, o)!);
		expect(b.max.y).toBeGreaterThan(g.thicknessMm / 2);
		expect(b.max.y).toBeLessThan(g.thicknessMm / 2 + 0.1);
		expect(b.max.y - b.min.y).toBeLessThan(0.15);
	});

	it('covers the nose and about 3 mm of each adjacent side', () => {
		const { g, o } = geomOf({ edge_count: 1, substrate: 'PCD' });
		const b = bounds(buildTipGeometry(g, o)!);
		expect(TIP_SIDE_MM).toBe(3);
		// An 80 degree corner: the sides run 40 degrees off the bisector, so 3 mm along a side is ~1.9 mm across.
		const halfWidth = (b.max.x - b.min.x) / 2;
		expect(halfWidth).toBeGreaterThan(TIP_SIDE_MM * Math.sin((40 * Math.PI) / 180) * 0.9);
		expect(halfWidth).toBeLessThan(TIP_SIDE_MM + g.noseRadiusMm);
	});

	it('gives each cutting corner its own pad: two on a two-edge insert, so twice the triangles', () => {
		const a = geomOf({ edge_count: 1, substrate: 'PCD' });
		const c = geomOf({ edge_count: 2, substrate: 'PCD' });
		const one = buildTipGeometry(a.g, a.o)!;
		const two = buildTipGeometry(c.g, c.o)!;
		expect(two.getAttribute('position').count).toBe(one.getAttribute('position').count * 2);
		const b = bounds(two);
		expect(b.max.z).toBeGreaterThan(0); // the opposite corner too
	});

	it('adds pads on the underside of a double-sided tipped insert', () => {
		const { g, o } = geomOf({ edge_count: 4, substrate: 'PCBN' }, 'CNGA 12 04 08');
		expect(g.doubleSided).toBe(true);
		const b = bounds(buildTipGeometry(g, o)!);
		expect(b.min.y).toBeLessThan(-g.thicknessMm / 2 + 0.05);
		expect(b.max.y).toBeGreaterThan(g.thicknessMm / 2);
	});

	it('leaves the reference mark clear of the pad, on a tipped insert', () => {
		const { g, o } = geomOf({ edge_count: 1, substrate: 'PCD' });
		const pos = buildTipGeometry(g, o)!.getAttribute('position');
		let apexZ = -Infinity; // the pad's inner point lies on the bisector (x = 0); corner 0 points to -z
		for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 1e-3) apexZ = Math.max(apexZ, pos.getZ(i));
		const mark = buildReferenceMark(g, o);
		mark.computeBoundingBox();
		expect(apexZ).toBeLessThan(-1);
		expect(mark.boundingBox!.min.z).toBeGreaterThanOrEqual(apexZ - 1e-6);
	});
});

describe('tip materials', () => {
	it('PCD is a lighter, more reflective silver than the body, in both themes', () => {
		for (const dark of [false, true]) {
			const m = new SceneMaterials(palette(dark));
			expect(luminance({ r: m.tipPcd.color.r, g: m.tipPcd.color.g, b: m.tipPcd.color.b, a: 1 })).toBeGreaterThan(
				luminance({ r: m.body.color.r, g: m.body.color.g, b: m.body.color.b, a: 1 }),
			);
			expect(m.tipPcd.metalness).toBeGreaterThan(m.body.metalness);
			expect(m.tipPcd.roughness).toBeLessThan(m.body.roughness);
			m.dispose();
		}
	});

	it('CBN is warm: more red than blue, and a little less shiny than PCD', () => {
		const m = new SceneMaterials(palette(false));
		expect(m.tipCbn.color.r).toBeGreaterThan(m.tipCbn.color.b);
		expect(m.tipCbn.roughness).toBeGreaterThan(m.tipPcd.roughness);
		m.dispose();
	});
});
