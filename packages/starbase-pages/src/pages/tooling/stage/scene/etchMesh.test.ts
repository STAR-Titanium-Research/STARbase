import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildToolingModel, type InsertRow } from '@d1/ui';
import { buildEtchGeometry, drawEtchAtlas, etchLabels, packAtlas, type EtchLabel } from './etchMesh';
import { numberAspect, trayLayout, type TrayLayout } from './trayMesh';

const box = { tool_box_id: 'b1', tool_box_code: 'BOX-1' };
const inserts = (n: number): InsertRow[] =>
	Array.from({ length: n }, (_, i) => ({ insert_id: `i${i}`, insert_code: `X-${i}`, insert_number: i + 1, is_depleted: false }));
const layoutOf = (n: number, iso: string | null = 'CNMG 12 04 08-MF', extra: Record<string, unknown> = {}): TrayLayout =>
	trayLayout(buildToolingModel(box, { iso_designation: iso, ...extra }, inserts(n), []));
const R390 = { type_code: 'R390-11 T3 08M-MM S30T', nose_radius_mm: 0.8, fixing_hole_diameter_mm: 2.8 };
const TITLES = { top: 'CNMG12-3', bottom: 'DNMG150604-MF1 TS2000 (A41)' };

const slotLabels = (labels: EtchLabel[]) => labels.filter((e) => e.slot >= 0);
const titleLabels = (labels: EtchLabel[]) => labels.filter((e) => e.slot < 0);
const overlaps = (a: EtchLabel, b: EtchLabel) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.h + b.h) / 2;

// Every text lies inside the tray and overlaps no pocket and no other text.
function expectClear(l: TrayLayout, labels: EtchLabel[]): void {
	const pockets = l.slots.map((s) => l.centre(s.column, s.row));
	for (const e of labels) {
		expect(e.h).toBeGreaterThan(0);
		expect(e.x - e.w / 2).toBeGreaterThan(-l.width / 2);
		expect(e.x + e.w / 2).toBeLessThan(l.width / 2);
		expect(e.z - e.h / 2).toBeGreaterThan(-l.depth / 2);
		expect(e.z + e.h / 2).toBeLessThan(l.depth / 2);
		for (const p of pockets) {
			const apartX = e.x + e.w / 2 <= p.x - l.pocketW / 2 || e.x - e.w / 2 >= p.x + l.pocketW / 2;
			const apartZ = e.z + e.h / 2 <= p.z - l.pocketD / 2 || e.z - e.h / 2 >= p.z + l.pocketD / 2;
			expect(apartX || apartZ).toBe(true);
		}
	}
	labels.forEach((a, i) => labels.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
}

// Where each slot number sits: beside its pocket in the outer columns, in front of it in an inner one.
function expectPlaced(l: TrayLayout, labels: EtchLabel[]): void {
	expect(labels).toHaveLength(l.slots.length);
	for (const e of labels) {
		const s = l.slots[e.slot];
		const c = l.centre(s.column, s.row);
		if (l.single) {
			expect(e.z - e.h / 2).toBeGreaterThan(c.z + l.pocketD / 2); // on the front wall
		} else if (s.column === 0) {
			expect(e.x + e.w / 2).toBeLessThan(c.x - l.pocketW / 2); // in the left margin, level with the pocket
			expect(e.z).toBeCloseTo(c.z, 9);
		} else if (s.column === l.columns - 1) {
			expect(e.x - e.w / 2).toBeGreaterThan(c.x + l.pocketW / 2); // in the right margin
			expect(e.z).toBeCloseTo(c.z, 9);
		} else {
			expect(e.x).toBeCloseTo(c.x, 9); // in front of the pocket
			expect(e.z - e.h / 2).toBeGreaterThan(c.z + l.pocketD / 2);
		}
	}
}

describe('etchLabels: slot numbers', () => {
	it('puts a two-column tray\'s numbers left of the left column and right of the right one, level with the pockets', () => {
		const l = layoutOf(10);
		const labels = etchLabels(l);
		expect(l.columns).toBe(2);
		expect(labels[0].text).toBe('1');
		expect(labels[0].x).toBeLessThan(l.centre(0, 0).x - l.pocketW / 2);
		expect(labels[1].text).toBe('2');
		expect(labels[1].x).toBeGreaterThan(l.centre(1, 0).x + l.pocketW / 2);
		expectPlaced(l, labels);
		expectClear(l, labels);
	});

	it('keeps an inner column\'s number in front of its pocket, in a tray of more than two columns', () => {
		const l = layoutOf(12, 'CCMT 09 T3 04');
		expect(l.columns).toBeGreaterThan(2);
		const labels = etchLabels(l);
		expectPlaced(l, labels);
		expectClear(l, labels);
		expect(labels.some((e) => l.slots[e.slot].column > 0 && l.slots[e.slot].column < l.columns - 1)).toBe(true);
	});

	it('fits, clear of the pockets, for a CNMG tray, a square one, a milling one, a single case and 2 to 60 slots', () => {
		for (const n of [2, 3, 10, 24, 60]) {
			const l = layoutOf(n);
			expectPlaced(l, etchLabels(l));
			expectClear(l, etchLabels(l, TITLES));
		}
		for (const l of [layoutOf(10, 'SNMG 12 04 08'), layoutOf(10, null, R390), layoutOf(60, 'VBMT 16 04 08'), layoutOf(24, 'CCMT 06 02 04'),
			layoutOf(1, 'CCGW 09T3 04', { edge_count: 1, substrate: 'PCD' })]) {
			expectPlaced(l, etchLabels(l));
			expectClear(l, etchLabels(l, TITLES));
		}
	});

	it('puts a single case\'s number on its front wall, toward +z', () => {
		const l = layoutOf(1, 'CCGW 09T3 04', { edge_count: 1, substrate: 'PCD' });
		const [e] = etchLabels(l);
		expect(l.single).toBe(true);
		expect(e.x).toBeCloseTo(0, 9);
		expect(e.z).toBeGreaterThan(l.pocketD / 2);
	});

	it('is big enough to read: a CNMG or SNMG tray gets numbers over 3 mm tall, whatever the side margin has to give', () => {
		expect(etchLabels(layoutOf(10))[0].h).toBeGreaterThan(3);
		expect(etchLabels(layoutOf(10, 'SNMG 12 04 08'))[0].h).toBeGreaterThan(3);
		expect(layoutOf(10, null, R390).numberH).toBeGreaterThan(1.8);
	});

	it('widens the side margins, not the text, when the widest number needs room (a 3-digit number)', () => {
		const narrow = layoutOf(10, 'CCMT 06 02 04');
		const wide = trayLayout(buildToolingModel(box, { iso_designation: 'CCMT 06 02 04' }, [
			...inserts(10), { insert_id: 'z', insert_code: 'Z', insert_number: 150, is_depleted: false },
		], []));
		expect(wide.slots.some((s) => s.label.length === 3)).toBe(true);
		for (const l of [narrow, wide]) {
			const longest = Math.max(...l.slots.map((s) => s.label.length));
			expect(l.sideRoom).toBeGreaterThanOrEqual(l.numberH * numberAspect(longest) + 2 - 1e-9);
			expectClear(l, etchLabels(l));
		}
		expect(wide.numberH).toBeCloseTo(narrow.numberH, 9); // the text kept its size
	});

	it('labels empty slots and extra pockets too, in slot order', () => {
		const l = trayLayout(buildToolingModel(box, { iso_designation: 'CNMG 12 04 08-MF' }, [
			{ insert_id: 'a', insert_code: 'A', insert_number: 1, is_depleted: false },
			{ insert_id: 'b', insert_code: 'B', insert_number: 3, is_depleted: false },
			{ insert_id: 'c', insert_code: 'C', insert_number: null, is_depleted: false },
		], []));
		expect(etchLabels(l).map((e) => e.text)).toEqual(l.slots.map((s) => s.label));
		expect(etchLabels(l).map((e) => e.text)).toContain('?');
		expect(l.slots.some((s) => s.insertId === null)).toBe(true); // the empty slot 2 has a number as well
	});

	it('gives every number the same height, and a longer number more width', () => {
		const labels = etchLabels(layoutOf(10));
		expect(labels[9].text).toBe('10');
		expect(labels[9].w).toBeGreaterThan(labels[0].w);
		expect(labels[9].h).toBe(labels[0].h);
	});
});

describe('etchLabels: the box code and the insert type', () => {
	it('etches the box code across the far end (-z) and the insert type across the near end (+z), centred', () => {
		const l = layoutOf(10);
		const labels = etchLabels(l, TITLES);
		const [top, bottom] = titleLabels(labels);
		expect(top.text).toBe('CNMG12-3');
		expect(bottom.text).toBe(TITLES.bottom);
		expect(top.x).toBe(0);
		expect(bottom.x).toBe(0);
		const firstBack = l.centre(0, 0).z - l.pocketD / 2;
		const lastFront = l.centre(0, l.rows - 1).z + l.pocketD / 2;
		expect(top.z + top.h / 2).toBeLessThan(firstBack); // above the first row
		expect(top.z).toBeLessThan(0);
		expect(bottom.z - bottom.h / 2).toBeGreaterThan(lastFront); // below the last row
		expect(bottom.z).toBeGreaterThan(0);
		expectClear(l, labels);
	});

	it('engraves nothing at the bottom without an insert type, nor without a box code at the top', () => {
		const l = layoutOf(10);
		expect(titleLabels(etchLabels(l, { top: 'B', bottom: null })).map((e) => e.text)).toEqual(['B']);
		expect(titleLabels(etchLabels(l, { top: null, bottom: 'T' })).map((e) => e.text)).toEqual(['T']);
		expect(titleLabels(etchLabels(l))).toEqual([]);
	});

	it('shrinks a long code to the tray\'s width, to a minimum, and never past the tray\'s sides', () => {
		for (const l of [layoutOf(2), layoutOf(10), layoutOf(10, null, R390), layoutOf(10, 'CCMT 06 02 04')]) {
			const short = titleLabels(etchLabels(l, { top: 'B1', bottom: null }))[0];
			const long = titleLabels(etchLabels(l, { top: TITLES.bottom, bottom: null }))[0];
			expect(long.h).toBeLessThanOrEqual(short.h + 1e-9);
			expect(long.h).toBeGreaterThanOrEqual(1.4 - 1e-9);
			expect(long.w).toBeLessThanOrEqual(l.width - 4 + 1e-9);
			expect(short.h).toBeLessThanOrEqual(l.endH + 1e-9);
		}
		// A long code on a wide tray keeps the full title height; on a narrow one it is smaller.
		const wide = layoutOf(60);
		expect(titleLabels(etchLabels(wide, { top: TITLES.bottom, bottom: null }))[0].h).toBeGreaterThan(
			titleLabels(etchLabels(layoutOf(2), { top: TITLES.bottom, bottom: null }))[0].h,
		);
	});

	it('squeezes a code too long for the minimum height, rather than overrun the tray', () => {
		const l = layoutOf(2);
		const [t] = titleLabels(etchLabels(l, { top: 'X'.repeat(80), bottom: null }));
		expect(t.h).toBeCloseTo(1.4, 9);
		expect(t.w).toBeLessThanOrEqual(l.width - 4 + 1e-9);
	});

	it('leaves the box code on a single case\'s back wall and no insert type (the front wall has the number)', () => {
		const l = layoutOf(1, 'CCGW 09T3 04', { edge_count: 1, substrate: 'PCD' });
		const labels = etchLabels(l, TITLES);
		expect(titleLabels(labels).map((e) => e.text)).toEqual(['CNMG12-3']);
		expect(titleLabels(labels)[0].z).toBeLessThan(-l.pocketD / 2);
		expectClear(l, labels);
	});

	it('widens the end margins when the title lines need room past the inner numbers of the last row', () => {
		const l = layoutOf(12, 'CCMT 09 T3 04');
		expect(l.columns).toBeGreaterThan(2);
		expect(l.endRoom).toBeGreaterThanOrEqual((l.pitch - l.pocketD) / 2 + l.numberH / 2 + l.endH + 2 - 1e-9);
		expectClear(l, etchLabels(l, TITLES));
	});
});

describe('packAtlas and buildEtchGeometry', () => {
	const l = layoutOf(60);
	const labels = etchLabels(l, TITLES);
	const atlas = packAtlas(labels);

	it('packs a power-of-two atlas with a disjoint cell per label, wide enough for a long title', () => {
		expect(Number.isInteger(Math.log2(atlas.width))).toBe(true);
		expect(Number.isInteger(Math.log2(atlas.height))).toBe(true);
		expect(atlas.cells).toHaveLength(60 + 2);
		for (const c of atlas.cells) {
			expect(c.x + c.w).toBeLessThanOrEqual(atlas.width);
			expect(c.y + c.h).toBeLessThanOrEqual(atlas.height);
		}
		for (let i = 0; i < atlas.cells.length; i++) {
			for (let j = i + 1; j < atlas.cells.length; j++) {
				const a = atlas.cells[i], b = atlas.cells[j];
				const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
				expect(apart).toBe(true);
			}
		}
	});

	it('is two upward-facing triangles per label, flat at the height asked, glyph tops toward -z', () => {
		const g = buildEtchGeometry(labels, atlas, 5.62);
		const p = g.getAttribute('position');
		const uv = g.getAttribute('uv');
		expect(p.count).toBe(labels.length * 6);
		for (let i = 0; i < p.count; i++) {
			expect(p.getY(i)).toBeCloseTo(5.62, 6);
			expect(g.getAttribute('normal').getY(i)).toBe(1);
		}
		// Winding agrees with the up normal: the y component of u x v is uz * vx - ux * vz.
		for (let i = 0; i < p.count; i += 3) {
			const ux = p.getX(i + 1) - p.getX(i), uz = p.getZ(i + 1) - p.getZ(i);
			const vx = p.getX(i + 2) - p.getX(i), vz = p.getZ(i + 2) - p.getZ(i);
			expect(uz * vx - ux * vz).toBeGreaterThan(0);
		}
		// The back edge (smaller z) maps to the top of the cell (larger v); every label, the titles too.
		labels.forEach((lab, n) => {
			const ks = [0, 1, 2, 3, 4, 5].map((k) => n * 6 + k);
			const back = ks.filter((k) => Math.abs(p.getZ(k) - (lab.z - lab.h / 2)) < 1e-6);
			const front = ks.filter((k) => Math.abs(p.getZ(k) - (lab.z + lab.h / 2)) < 1e-6);
			expect(Math.min(...back.map((k) => uv.getY(k)))).toBeGreaterThan(Math.max(...front.map((k) => uv.getY(k))));
			// and the left edge to the cell's left: text reads along +x
			const left = ks.filter((k) => Math.abs(p.getX(k) - (lab.x - lab.w / 2)) < 1e-6);
			const right = ks.filter((k) => Math.abs(p.getX(k) - (lab.x + lab.w / 2)) < 1e-6);
			expect(Math.max(...left.map((k) => uv.getX(k)))).toBeLessThan(Math.min(...right.map((k) => uv.getX(k))));
		});
	});
});

describe('drawEtchAtlas', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('is null where there is no canvas (Node), or no 2D context', () => {
		const labels = etchLabels(layoutOf(2));
		expect(drawEtchAtlas(labels, packAtlas(labels))).toBeNull();
		vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
		expect(drawEtchAtlas(labels, packAtlas(labels))).toBeNull();
	});

	it('draws each text white into its cell, squeezed to the cell, and returns a texture of the canvas', () => {
		const drawn: Array<[string, number, number, number]> = [];
		const ctx = {
			clearRect() {}, fillStyle: '', font: '', textAlign: '', textBaseline: '',
			fillText: (t: string, x: number, y: number, maxW: number) => drawn.push([t, x, y, maxW]),
		};
		vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
		const labels = etchLabels(layoutOf(3), TITLES);
		const atlas = packAtlas(labels);
		const texture = drawEtchAtlas(labels, atlas)!;
		expect(texture).not.toBeNull();
		expect(drawn.map((d) => d[0])).toEqual(['1', '2', '3', 'CNMG12-3', TITLES.bottom]);
		drawn.forEach((d, i) => expect(d[3]).toBeLessThanOrEqual(atlas.cells[i].w));
		expect(ctx.fillStyle).toBe('#fff');
		texture.dispose();
	});
});
