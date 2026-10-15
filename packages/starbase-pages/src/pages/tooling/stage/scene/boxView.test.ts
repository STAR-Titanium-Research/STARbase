import { afterEach, describe, expect, it, vi } from 'vitest';
import { Raycaster, Vector3, type Intersection } from 'three';
import { buildToolingModel, type EdgeRow, type InsertRow, type ToolingFocus } from '@d1/ui';
import { BoxView, type ViewState } from './boxView';
import { edgeColour, etchInk, SceneMaterials } from './materials';
import { etchLabels } from './etchMesh';
import { luminance, type Palette, type Rgba } from './themePalette';

const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });
const palette = (dark: boolean): Palette => ({
	tile: dark ? rgb(0.08, 0.1, 0.13) : rgb(0.9, 0.91, 0.93), tray: rgb(0.5, 0.5, 0.5), ink: rgb(0.1, 0.1, 0.1),
	body: rgb(0.3, 0.3, 0.32), mark: rgb(0.6, 0.6, 0.6), ok: rgb(0.1, 0.6, 0.3), warn: rgb(0.8, 0.5, 0.1),
	dim: rgb(0.5, 0.5, 0.55), accent: rgb(0.2, 0.4, 0.8), pick: rgb(0.6, 0.7, 0.9), select: rgb(0.25, 0.41, 0.88),
	tipPcd: rgb(0.85, 0.86, 0.88), tipCbn: rgb(0.55, 0.45, 0.3),
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
		const before = m.ring.hover.color.getHex();
		m.update({ ...palette(false), accent: rgb(0.9, 0.1, 0.1) });
		expect(m.ring.hover.color.getHex()).not.toBe(before);
		expect(m.ring.depleted.opacity).toBeCloseTo(0.35, 6);
		expect(m.bodyGhost.opacity).toBeCloseTo(0.35, 6);
	});

	it('draws every pocket ring in one neutral groove tone, whatever the state, so it never blends with the green fresh edges', () => {
		for (const dark of [false, true]) {
			const m = new SceneMaterials({ ...palette(dark), ok: rgb(0.1, 0.8, 0.4), warn: rgb(0.9, 0.6, 0.1) });
			const groove = m.ring.fresh.color.getHex();
			for (const tone of ['partly-used', 'used', 'depleted'] as const) expect(m.ring[tone].color.getHex()).toBe(groove);
			expect(groove).not.toBe(m.edge.fresh.color.getHex()); // not the fresh edge's green
			expect(m.ring.fresh.color.g).toBeLessThan(0.7);
			const tray = m.tray.color;
			const g = m.ring.fresh.color;
			// subtle: close to the tray's own tone (within a quarter of the range in every channel)
			expect(Math.abs(g.r - tray.r)).toBeLessThan(0.25);
			expect(Math.abs(g.g - tray.g)).toBeLessThan(0.25);
			expect(Math.abs(g.b - tray.b)).toBeLessThan(0.25);
			expect(m.ring.depleted.opacity).toBeCloseTo(0.35, 6); // depleted stays ghosted
			expect(m.ring.selected.color.getHex()).toBe(m.edge.selected.color.getHex()); // the selected ring is the selection blue
			expect(m.ring.hover.color.getHex()).not.toBe(groove);
			expect(m.ring.selected.color.getHex()).not.toBe(groove);
			m.dispose();
		}
	});

	it('lifts the edge colours on a dark stage and leaves a light stage as it is', () => {
		const p = { ...palette(false), ok: rgb(0.1, 0.6, 0.3), dim: rgb(0.5, 0.5, 0.55) };
		expect(edgeColour(p.ok, false)).toEqual(p.ok);
		const lit = edgeColour(p.ok, true);
		expect(luminance(lit)).toBeGreaterThan(luminance(p.ok));
		expect(lit.g).toBeGreaterThan(lit.r); // still green, not washed to white
		const light = new SceneMaterials(p);
		const dark = new SceneMaterials({ ...palette(true), ok: p.ok, dim: p.dim });
		expect(dark.edge.fresh.color.g).toBeGreaterThan(light.edge.fresh.color.g);
		expect(dark.edge.used.color.r).toBeGreaterThan(light.edge.used.color.r);
		light.dispose();
		dark.dispose();
	});

	it('colours the selected edge with its own selection colour, apart from the hover lift and the state colours', () => {
		const m = new SceneMaterials(palette(false));
		const hex = (c: { getHex(): number }) => c.getHex();
		expect(hex(m.edge.selected.color)).toBe(hex(m.edge.glow.color));
		for (const other of [m.edge.hover, m.edge.fresh, m.edge.used, m.edge.halo]) expect(hex(m.edge.selected.color)).not.toBe(hex(other.color));
		const before = hex(m.edge.selected.color);
		m.update({ ...palette(false), select: rgb(0.9, 0.2, 0.2) });
		expect(hex(m.edge.selected.color)).not.toBe(before);
		expect(m.edge.selected.opacity).toBe(1);
		expect(m.edge.glow.opacity).toBeLessThan(m.edge.selected.opacity); // a soft glow around the solid tube
	});

	it('inks the etched numbers darker than the tray on a light stage, and lighter on a dark one, and recolours on a theme change', () => {
		const light = { ...palette(false), ink: rgb(0.08, 0.1, 0.2), tray: rgb(0.78, 0.79, 0.82) };
		const dark = { ...palette(true), ink: rgb(0.92, 0.94, 0.97), tray: rgb(0.1, 0.12, 0.15) };
		expect(luminance(etchInk(light.ink, light.tray, false))).toBeLessThan(luminance(light.tray));
		expect(luminance(etchInk(dark.ink, dark.tray, true))).toBeGreaterThan(luminance(dark.tray));
		// Eased toward the tray, so it reads as cut into it: not quite the page's ink.
		expect(luminance(etchInk(light.ink, light.tray, false))).toBeGreaterThan(luminance(light.ink));
		const m = new SceneMaterials(light);
		const asLight = m.etch.color.getHex();
		m.update(dark);
		expect(m.etch.color.getHex()).not.toBe(asLight);
		const hex = m.etch.color.getHex(); // sRGB
		expect(luminance({ r: (hex >> 16) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 })).toBeGreaterThan(0.3); // legible on the dark tray
	});

	it('makes the reference arrow near-white in the light theme and keeps it flat (not tone mapped)', () => {
		const m = new SceneMaterials({ ...palette(false), mark: rgb(0.94, 0.94, 0.96) });
		expect(m.mark.toneMapped).toBe(false);
		expect(luminance({ r: m.mark.color.r, g: m.mark.color.g, b: m.mark.color.b, a: 1 })).toBeGreaterThan(
			luminance({ r: m.body.color.r, g: m.body.color.g, b: m.body.color.b, a: 1 }) * 3,
		);
	});

	it('knows a dark stage from a light one', () => {
		expect(luminance(palette(true).tile)).toBeLessThan(0.35);
		expect(new SceneMaterials(palette(true)).isDark).toBe(true);
		expect(new SceneMaterials(palette(false)).isDark).toBe(false);
	});
});

describe('BoxView with a tipped insert type', () => {
	const tipped = (substrate: string | null) => {
		const one: InsertRow[] = [{ insert_id: 'p1', insert_code: 'P-1', insert_number: 1, is_depleted: false }];
		const e: EdgeRow[] = [{ edge_id: 'p1A', edge_code: 'P-1A', insert_id: 'p1', edge_identifier: 'A', is_used: false }];
		const m = buildToolingModel({ tool_box_id: 'b', tool_box_code: 'B' }, { iso_designation: 'CCGW 09T3 04', edge_count: 1, substrate }, one, e);
		const mats = new SceneMaterials(palette(false));
		return { mats, view: new BoxView(m, mats), m };
	};
	const tipsOf = (v: BoxView) => v.root.getObjectByName('tips') as import('three').InstancedMesh | undefined;

	it('draws a tip pad instance per solid insert, in the PCD or the CBN material', () => {
		const pcd = tipped('PCD');
		pcd.view.sync(state(BOX));
		expect(tipsOf(pcd.view)!.count).toBe(1);
		expect(tipsOf(pcd.view)!.material).toBe(pcd.mats.tipPcd);
		const cbn = tipped('PCBN');
		cbn.view.sync(state(BOX));
		expect(tipsOf(cbn.view)!.material).toBe(cbn.mats.tipCbn);
	});

	it('draws no tips for plain carbide', () => {
		expect(tipsOf(tipped('Carbide').view)).toBeUndefined();
		expect(tipsOf(make().view)).toBeUndefined();
	});

	it('does not pick the tip pad: the insert still picks, and only edge A of the one-edge insert is drawn', () => {
		const { view, m } = tipped('PCD');
		view.sync(state(BOX));
		const c = view.insertCentre('p1');
		expect(pickDown(view, BOX, [c[0] + 3.5, 0, c[2]])).toEqual({ kind: 'insert', insertId: 'p1' });
		let tubes = 0;
		view.root.traverse((o) => { if (o.userData.kind === 'edge') tubes++; });
		expect(tubes).toBe(2);
		expect(m.geometry.cuttingCorners).toEqual([0]);
	});
});

// The tray's etched numbers need a canvas; in Node a stub stands in, which is all a CanvasTexture needs.
describe('BoxView etched slot numbers', () => {
	afterEach(() => vi.unstubAllGlobals());
	const stubCanvas = () => {
		const ctx = { fillRect() {}, fillText() {}, measureText: (t: string) => ({ width: t.length * 40 }), fillStyle: '', font: '', textAlign: '', textBaseline: '' };
		vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
	};
	const etchOf = (view: BoxView, mats: SceneMaterials) => view.root.children.find((o) => (o as import('three').Mesh).material === mats.etch) as import('three').Mesh | undefined;

	it('draws no etch without a canvas (Node), and still builds the rest of the box', () => {
		const { view, mats } = make();
		expect(etchOf(view, mats)).toBeUndefined();
		expect(mats.etch.alphaMap).toBeNull();
		expect(view.pickables(BOX).length).toBeGreaterThan(10);
	});

	it('etches one quad per slot (empty ones too) flat on the tray top, outside the highlight overlays', () => {
		stubCanvas();
		const { view, mats } = make();
		const etch = etchOf(view, mats)!;
		expect(etch).toBeDefined();
		expect(mats.etch.alphaMap).not.toBeNull();
		expect(mats.etch.map).toBeNull(); // the atlas is an alpha map: opaque canvas, so no straight-alpha fringe
		expect(etch.geometry.getAttribute('position').count).toBe((view.layout.slots.length + 2) * 6); // a quad per slot, plus the box code and the type
		etch.geometry.computeBoundingBox();
		const b = etch.geometry.boundingBox!;
		expect(b.min.y).toBeGreaterThan(view.layout.topY);
		expect(b.max.y).toBeLessThan(view.layout.topY + 0.1);
		expect(etch.renderOrder).toBeLessThan(3);
		expect(mats.etch.depthWrite).toBe(false);
		expect(mats.etch.polygonOffset).toBe(true);
	});

	it('does not move with insert lifts', () => {
		stubCanvas();
		const { view, mats } = make();
		const etch = etchOf(view, mats)!;
		const before = Array.from(etch.geometry.getAttribute('position').array);
		view.sync(state({ kind: 'insert', insertId: 'i3' }, { lifts: new Map([['i3', 9]]) }));
		expect(Array.from(etch.geometry.getAttribute('position').array)).toEqual(before);
		expect(etch.position.y).toBe(0);
	});

	it('picks the slot\'s insert from a click on its etched number, from the box and from a focused insert', () => {
		stubCanvas();
		const { view, mats } = make();
		view.sync(state(BOX));
		const labels = etchLabels(view.layout);
		for (const k of [0, 4, 9]) {
			const l = labels[k];
			expect(pickDown(view, BOX, [l.x, 0, l.z])).toEqual({ kind: 'insert', insertId: `i${k + 1}` });
		}
		const focus: ToolingFocus = { kind: 'insert', insertId: 'i3' };
		view.sync(state(focus));
		expect(pickDown(view, focus, [labels[0].x, 0, labels[0].z])).toEqual({ kind: 'insert', insertId: 'i1' });
		expect(etchOf(view, mats)).toBeDefined();
	});

	it('picks nothing from the number of an empty slot, and disposes its texture and map', () => {
		stubCanvas();
		const fewer = buildToolingModel({ tool_box_id: 'b', tool_box_code: 'B' }, { iso_designation: 'CNMG 12 04 08-MF' },
			[{ insert_id: 'a', insert_code: 'A', insert_number: 1, is_depleted: false }, { insert_id: 'c', insert_code: 'C', insert_number: 3, is_depleted: false }], []);
		const mats = new SceneMaterials(palette(false));
		const view = new BoxView(fewer, mats);
		view.sync(state(BOX));
		const empty = etchLabels(view.layout).find((l) => view.layout.slots[l.slot].insertId === null)!;
		expect(empty.text).toBe('2');
		expect(pickDown(view, BOX, [empty.x, 0, empty.z])).toBeNull();
		const texture = mats.etch.alphaMap!;
		let disposed = false;
		texture.addEventListener('dispose', () => { disposed = true; });
		view.dispose();
		expect(disposed).toBe(true);
		expect(mats.etch.alphaMap).toBeNull();
		mats.dispose();
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

	it('has no slot pills at box level (the numbers are etched in the tray) and edge letters at insert level', () => {
		const { view } = make();
		expect(view.labels(BOX)).toEqual([]);

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
		expect(visibleOverlays).toHaveLength(1); // only the next-fresh halo (no selection, so no glow)
		view.sync(state({ kind: 'edge', insertId: 'i2', edgeId: 'i2B' }, { nextFresh: { insertId: 'i2', edgeId: 'i2B' } }));
		const now = (hidden() as import('three').Mesh[]).filter((m) => m.renderOrder >= 3 && m.visible);
		expect(now).toHaveLength(2); // the selection (the tube and its glow) replaces the halo on the same edge
		const radius = (m: import('three').Mesh) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox!.max.y - m.geometry.boundingBox!.min.y; };
		const [tube, glow] = (now as import('three').Mesh[]).sort((a, b) => radius(a) - radius(b));
		expect(radius(glow)).toBeGreaterThan(radius(tube) * 1.5);
		expect(radius(tube)).toBeGreaterThan(2 * 0.22 * 1.5); // clearly thicker than the 0.22 mm edge tube it covers
	});

	it('draws a hovered edge thinner than a selected one, and the glow pulses with the pulse', () => {
		const { view, mats } = make();
		const focus: ToolingFocus = { kind: 'edge', insertId: 'i2', edgeId: 'i2B' };
		view.sync(state(focus, { hover: { kind: 'edge', insertId: 'i2', edgeId: 'i2C' }, pulse: 1 }));
		const overlays = (view.root.children as import('three').Mesh[]).filter((m) => m.renderOrder >= 3 && m.visible);
		const height = (m: import('three').Mesh) => { m.geometry.computeBoundingBox(); return m.geometry.boundingBox!.max.y - m.geometry.boundingBox!.min.y; };
		const hovered = overlays.find((m) => m.material === mats.edge.hover)!;
		const selected = overlays.find((m) => m.material === mats.edge.selected)!;
		expect(height(hovered)).toBeLessThan(height(selected));
		expect(mats.edge.hover.opacity).toBeLessThan(mats.edge.selected.opacity);
		const full = mats.edge.glow.opacity;
		view.sync(state(focus, { pulse: 0 }));
		expect(mats.edge.glow.opacity).toBeLessThan(full);
		expect(mats.edge.glow.opacity).toBeGreaterThan(0.1);
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
