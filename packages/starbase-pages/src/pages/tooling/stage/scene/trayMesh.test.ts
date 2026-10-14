import { describe, expect, it } from 'vitest';
import { buildToolingModel, type InsertRow } from '@d1/ui';
import {
	buildPocketRingGeometry, buildTrayGeometry, FLOOR_MM, POCKET_DEPTH_MM, slotLabelAnchor, slotPosition, trayLayout,
} from './trayMesh';

const box = { tool_box_id: 'b1', tool_box_code: 'BOX-1' };
const inserts = (numbers: Array<number | null>): InsertRow[] =>
	numbers.map((n, i) => ({ insert_id: `i${i}`, insert_code: `X-${i}`, insert_number: n, is_depleted: false }));
const tenInserts = inserts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const cnmg = { iso_designation: 'CNMG 12 04 08-MF' };
const ten = buildToolingModel(box, cnmg, tenInserts, []);

describe('trayLayout', () => {
	it('lays 10 inserts out as 2 columns x 5 rows, in reading order', () => {
		const l = trayLayout(ten);
		expect([l.columns, l.rows, l.slots.length]).toEqual([2, 5, 10]);
		expect(l.slots[0]).toMatchObject({ column: 0, row: 0, label: '1', insertId: 'i0' });
		expect(l.slots[5]).toMatchObject({ column: 1, row: 2, label: '6', insertId: 'i5' });
		const first = l.centre(0, 0);
		const second = l.centre(1, 0);
		const below = l.centre(0, 1);
		expect(second.x - first.x).toBeCloseTo(l.pitch, 6);
		expect(below.z - first.z).toBeCloseTo(l.pitch, 6);
		expect(first.x + second.x).toBeCloseTo(0, 6); // centred on the origin
		expect(l.depth).toBeGreaterThan(l.width); // portrait: the long side runs along z
	});

	it('spaces the slots at about 1.7 x IC, and wide enough for the longest corner', () => {
		const l = trayLayout(ten);
		expect(l.pitch).toBeGreaterThanOrEqual(1.7 * 12.7 - 1e-6);
		expect(l.pocketD).toBeGreaterThan(2 * 9.4); // the CNMG nose reaches 9.4 mm from the centre
		expect(l.pitch).toBeGreaterThan(l.pocketD);
		expect(l.pitch).toBeGreaterThan(l.pocketW);
	});

	it('gives an insert with a missing or duplicate number an extra pocket, marked ?', () => {
		const m = buildToolingModel(box, cnmg, inserts([1, 2, null, 2]), []);
		const l = trayLayout(m);
		const labels = l.slots.map((s) => s.label);
		expect(labels.filter((x) => x === '?')).toHaveLength(2);
		expect(l.slots.filter((s) => s.insertId).map((s) => s.insertId).sort()).toEqual(['i0', 'i1', 'i2', 'i3']);
		for (const i of m.inserts) expect(l.slotOf.has(i.id)).toBe(true);
	});

	it('is a 1 x 1 empty tray with no slots for an empty box', () => {
		const l = trayLayout(buildToolingModel(box, cnmg, [], []));
		expect([l.columns, l.rows, l.slots.length]).toEqual([1, 1, 0]);
		expect(l.width).toBeGreaterThan(0);
	});

	it('rests an insert on the pocket floor, with the tray top above the floor', () => {
		const l = trayLayout(ten);
		expect(l.floorY).toBe(FLOOR_MM);
		expect(l.topY).toBeCloseTo(FLOOR_MM + POCKET_DEPTH_MM, 6);
		expect(l.insertY - 4.76 / 2).toBeGreaterThan(l.floorY);
		const p = slotPosition(l, l.slots[0]);
		expect(p.y).toBe(l.insertY);
		const a = slotLabelAnchor(l, l.slots[0]);
		expect(a[1]).toBe(l.topY);
		expect(a[2]).toBeGreaterThan(p.z); // on the front rim
	});
});

describe('trayLayout of a one-insert box', () => {
	const pcd = { iso_designation: 'CCGW 09T3 04', edge_count: 1, substrate: 'PCD' };
	const one = buildToolingModel(box, pcd, inserts([1]), []);

	it('is a small single case, one slot, sized to the insert and not to the 1.7 x IC pitch of a tray', () => {
		const l = trayLayout(one);
		expect([l.columns, l.rows, l.slots.length]).toEqual([1, 1, 1]);
		expect(l.single).toBe(true);
		expect(l.slots[0]).toMatchObject({ column: 0, row: 0, label: '1', insertId: 'i0' });
		const trayOfOne = trayLayout(buildToolingModel(box, pcd, inserts([1, 2]), []));
		expect(trayOfOne.single).toBe(false);
		expect(l.width).toBeLessThan(trayOfOne.width * 0.8);
		// The case is the pocket plus a thin wall: the insert's reach fills most of it.
		expect(l.width).toBeLessThan(l.pocketW + 6);
		expect(l.depth).toBeLessThan(l.pocketD + 6);
		expect(l.width).toBeGreaterThan(l.pocketW);
		expect(l.centre(0, 0)).toEqual({ x: 0, z: 0 });
	});

	it('names the slot by the insert number, or ? when it has none, and still rests the insert in the pocket', () => {
		expect(trayLayout(buildToolingModel(box, pcd, inserts([null]), [])).slots[0]).toMatchObject({ label: '?', insertId: 'i0' });
		const seven = trayLayout(buildToolingModel(box, pcd, inserts([7]), []));
		expect(seven.slots).toHaveLength(1); // not a grid sized to the highest number
		expect(seven.slots[0].label).toBe('7');
		expect(seven.slotOf.has('i0')).toBe(true);
	});

	it('builds its geometry like any tray', () => {
		const g = buildTrayGeometry(trayLayout(one));
		g.computeBoundingBox();
		expect(g.boundingBox!.max.y).toBeCloseTo(trayLayout(one).topY, 2);
	});
});

describe('buildTrayGeometry', () => {
	it('is as wide and deep as the layout, from y = 0 to the tray top', () => {
		const l = trayLayout(ten);
		const g = buildTrayGeometry(l);
		g.computeBoundingBox();
		const b = g.boundingBox!;
		expect(b.max.x - b.min.x).toBeCloseTo(l.width, 1);
		expect(b.max.z - b.min.z).toBeCloseTo(l.depth, 1);
		expect(b.min.y).toBeCloseTo(0, 2);
		expect(b.max.y).toBeCloseTo(l.topY, 2);
		expect(g.getAttribute('position').count % 3).toBe(0);
	});

	it('grows with the number of pockets (they are cut as shape holes)', () => {
		const few = buildToolingModel(box, cnmg, inserts([1, 2]), []);
		const a = buildTrayGeometry(trayLayout(few)).getAttribute('position').count;
		const b = buildTrayGeometry(trayLayout(ten)).getAttribute('position').count;
		expect(b).toBeGreaterThan(a);
	});

	it('builds an empty tray', () => {
		const g = buildTrayGeometry(trayLayout(buildToolingModel(box, cnmg, [], [])));
		expect(g.getAttribute('position').count).toBeGreaterThan(0);
	});
});

describe('buildPocketRingGeometry', () => {
	it('is a flat frame just above the pocket floor, inside the pocket', () => {
		const l = trayLayout(ten);
		const g = buildPocketRingGeometry(l);
		g.computeBoundingBox();
		const b = g.boundingBox!;
		expect(b.min.y).toBeGreaterThan(l.floorY);
		expect(b.max.y - b.min.y).toBeLessThan(0.01);
		expect(b.max.x - b.min.x).toBeLessThan(l.pocketW);
		expect(b.max.z - b.min.z).toBeLessThan(l.pocketD);
		const n = g.getAttribute('normal');
		expect(n.getY(0)).toBeGreaterThan(0.99); // faces up
	});
});
