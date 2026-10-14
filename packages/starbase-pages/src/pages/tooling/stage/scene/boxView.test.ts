import { describe, expect, it } from 'vitest';
import { Raycaster, Vector3, type Intersection } from 'three';
import { buildToolingModel, type EdgeRow, type InsertRow, type ToolingFocus } from '@d1/ui';
import { BoxView, type ViewState } from './boxView';
import { SceneMaterials } from './materials';
import { luminance, type Palette, type Rgba } from './themePalette';

const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });
const palette = (dark: boolean): Palette => ({
	tile: dark ? rgb(0.08, 0.1, 0.13) : rgb(0.9, 0.91, 0.93), tray: rgb(0.5, 0.5, 0.5), ink: rgb(0.1, 0.1, 0.1),
	body: rgb(0.3, 0.3, 0.32), mark: rgb(0.6, 0.6, 0.6), ok: rgb(0.1, 0.6, 0.3), warn: rgb(0.8, 0.5, 0.1),
	dim: rgb(0.5, 0.5, 0.55), accent: rgb(0.2, 0.4, 0.8), pick: rgb(0.6, 0.7, 0.9),
});

const inserts: InsertRow[] = Array.from({ length: 10 }, (_, i) => ({
	insert_id: `i${i + 1}`, insert_code: `X-${i + 1}`, insert_number: i + 1, is_depleted: i === 9,
}));
const edges: EdgeRow[] = inserts.flatMap((i) => ['A', 'B', 'C', 'D'].map((l, k) => ({
	edge_id: `${i.insert_id}${l}`, edge_code: `${i.insert_code}${l}`, insert_id: i.insert_id, edge_identifier: l, is_used: k === 0 && i.insert_id === 'i2',
})));
const model = buildToolingModel({ tool_box_id: 'b', tool_box_code: 'B' }, { iso_designation: 'CNMG 12 04 08-MF' }, inserts, edges);

const state = (focus: ToolingFocus, extra: Partial<ViewState> = {}): ViewState => ({
	focus, lifts: new Map(), hover: null, nextFresh: null, pulse: 1, ...extra,
});
const BOX: ToolingFocus = { kind: 'box' };

function make() {
	const mats = new SceneMaterials(palette(false));
	return { mats, view: new BoxView(model, mats) };
}

// A ray straight down onto a point, for picking through the real raycaster (no WebGL needed).
function pickDown(view: BoxView, focus: ToolingFocus, at: [number, number, number]) {
	view.root.updateMatrixWorld(true);
	const rc = new Raycaster(new Vector3(at[0], 200, at[2]), new Vector3(0, -1, 0));
	rc.layers.enableAll();
	const hits: Intersection[] = rc.intersectObjects(view.pickables(focus), false);
	for (const h of hits) {
		const t = view.resolve(h, focus);
		if (t) return t;
	}
	return null;
}

describe('SceneMaterials', () => {
	it('takes state colours from the palette, and recolours on update', () => {
		const m = new SceneMaterials(palette(false));
		expect(m.ring.fresh.color.getHex()).not.toBe(m.ring.used.color.getHex());
		const before = m.ring.selected.color.getHex();
		m.update({ ...palette(false), accent: rgb(0.9, 0.1, 0.1) });
		expect(m.ring.selected.color.getHex()).not.toBe(before);
		expect(m.ring.depleted.opacity).toBeCloseTo(0.35, 6);
		expect(m.bodyGhost.opacity).toBeCloseTo(0.35, 6);
	});

	it('knows a dark stage from a light one', () => {
		expect(luminance(palette(true).tile)).toBeLessThan(0.35);
		expect(new SceneMaterials(palette(true)).isDark).toBe(true);
		expect(new SceneMaterials(palette(false)).isDark).toBe(false);
	});
});

describe('BoxView', () => {
	it('draws one pickable edge segment per placed edge, and a fat pick tube for each', () => {
		const { view } = make();
		let tubes = 0;
		view.root.traverse((o) => { if (o.userData.kind === 'edge') tubes++; });
		expect(tubes).toBe(10 * 4 * 2); // a visible tube and a pick tube for 40 edges
		expect(view.layout.slots).toHaveLength(10);
	});

	it('fills the solid instances, and the depleted insert goes to the see-through ones', () => {
		const { view } = make();
		view.sync(state(BOX));
		const meshes = view.root.children.filter((o) => (o as { isInstancedMesh?: boolean }).isInstancedMesh) as import('three').InstancedMesh[];
		const [solid, ghost, marks] = meshes;
		expect(solid.count).toBe(9);
		expect(ghost.count).toBe(1);
		expect(marks.count).toBe(9);
	});

	it('ghosts every other insert once one is focused', () => {
		const { view } = make();
		view.sync(state({ kind: 'insert', insertId: 'i3' }));
		const [solid, ghost] = view.root.children.filter((o) => (o as { isInstancedMesh?: boolean }).isInstancedMesh) as import('three').InstancedMesh[];
		expect(solid.count).toBe(1);
		expect(ghost.count).toBe(9);
	});

	it('raises a focused insert by its lift', () => {
		const { view } = make();
		const base = view.insertCentre('i3');
		const up = view.insertCentre('i3', 9);
		expect(up[1] - base[1]).toBe(9);
		expect(up[0]).toBe(base[0]);
	});

	it('picks the insert under a ray, by instance id, from the box', () => {
		const { view } = make();
		view.sync(state(BOX));
		for (const id of ['i1', 'i5', 'i8']) {
			const c = view.insertCentre(id);
			expect(pickDown(view, BOX, [c[0] + 2.5, 0, c[2] + 1])).toEqual({ kind: 'insert', insertId: id });
		}
	});

	it('picks a ghosted (depleted) insert too', () => {
		const { view } = make();
		view.sync(state(BOX));
		const c = view.insertCentre('i10');
		expect(pickDown(view, BOX, [c[0] + 3, 0, c[2] + 1])).toEqual({ kind: 'insert', insertId: 'i10' });
	});

	it('picks an edge only once its insert is focused', () => {
		const { view } = make();
		const focus: ToolingFocus = { kind: 'insert', insertId: 'i2' };
		view.sync(state(focus));
		const c = view.insertCentre('i2');
		// straight down onto corner 0's nose, which is toward -z
		const nose: [number, number, number] = [c[0], 0, c[2] - 8.9];
		expect(pickDown(view, focus, nose)).toEqual({ kind: 'edge', insertId: 'i2', edgeId: 'i2A' });
		expect(pickDown(view, BOX, nose)?.kind).not.toBe('edge');
	});

	it('shows slot numbers at box level and edge letters at insert level', () => {
		const { view } = make();
		const box = view.labels(BOX);
		expect(box.map((l) => l.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
		expect(box.every((l) => l.target?.kind === 'insert')).toBe(true);
		expect(box.find((l) => l.text === '10')!.tone).toBe('dim'); // depleted
		expect(box.find((l) => l.text === '2')!.tone).toBe('warn'); // part used

		const insert = view.labels({ kind: 'insert', insertId: 'i2' });
		expect(insert.map((l) => l.text)).toEqual(['A', 'B', 'C', 'D']);
		expect(insert.find((l) => l.text === 'A')!.tone).toBe('dim'); // used
		expect(insert.find((l) => l.text === 'B')!.tone).toBe('ok');
		const edge = view.labels({ kind: 'edge', insertId: 'i2', edgeId: 'i2B' });
		expect(edge.find((l) => l.text === 'B')!.selected).toBe(true);
		expect(edge.find((l) => l.text === 'A')!.selected).toBe(false);
	});

	it('shows the highlights only for what they mark', () => {
		const { view } = make();
		const hidden = () => view.root.children.filter((o) => (o as { isMesh?: boolean }).isMesh && !(o as { isInstancedMesh?: boolean }).isInstancedMesh);
		view.sync(state(BOX, { nextFresh: { insertId: 'i2', edgeId: 'i2B' } }));
		const visibleOverlays = (hidden() as import('three').Mesh[]).filter((m) => m.renderOrder >= 3 && m.visible);
		expect(visibleOverlays).toHaveLength(1); // only the next-fresh halo
		view.sync(state({ kind: 'edge', insertId: 'i2', edgeId: 'i2B' }, { nextFresh: { insertId: 'i2', edgeId: 'i2B' } }));
		const now = (hidden() as import('three').Mesh[]).filter((m) => m.renderOrder >= 3 && m.visible);
		expect(now).toHaveLength(1); // the selection replaces the halo on the same edge
	});

	it('disposes its geometries and leaves nothing in the group', () => {
		const { view, mats } = make();
		view.sync(state(BOX));
		let disposed = 0;
		view.root.traverse((o) => {
			const g = (o as { geometry?: import('three').BufferGeometry }).geometry;
			g?.addEventListener('dispose', () => { disposed++; });
		});
		view.dispose();
		expect(disposed).toBeGreaterThan(5);
		expect(view.root.children).toHaveLength(0);
		mats.dispose();
	});
});
