// The tool box tray: where each slot is, and the tray's geometry (slab, shallow pockets, state rings).
// World space: y up, the tray's bottom at y = 0, its centre on the y axis; slot (0, 0) is at the back left
// (-z is "up" on screen for the default camera), so the numbers read left to right, then toward the camera.

import { ExtrudeGeometry, Path, Shape, ShapeGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ToolingModel } from '@d1/ui';

export const FLOOR_MM = 3; // the solid base under the pockets
export const POCKET_DEPTH_MM = 2.6;
export const RING_WIDTH_MM = 0.7;
const POCKET_MARGIN_MM = 2.4; // clearance around the insert, all sides, to the pocket wall
// A box of one insert is a small case: a snug pocket and a thin wall, so the insert fills most of it.
const CASE_POCKET_MARGIN_MM = 2;
const CASE_WALL_MM = 2.6; // wide enough for the etched number on its front
const SLOT_GAP_MM = 5; // minimum wall between two pockets; also the strip an inner column's etched number sits in
const TRAY_BEVEL_MM = 0.25;
const RING_LIFT_MM = 0.03;
// The etched text (etchMesh.ts): a slot number is as tall as this share of the pocket's width, a title line (the box
// code, the insert type) a little less; a hair of tray is kept around each.
const NUMBER_H_SHARE = 0.3;
const END_H_SHARE = 0.25;
const FAR_END_SCALE = 1.45; // the far end's title is this much taller than the near end's
const TEXT_PAD_MM = 1;
const NUMBER_FRONT_SHARE = 0.7; // an etched number in front of a pocket takes this much of the strip there
// The width of a slot number of `chars` characters, as a multiple of its height.
export const numberAspect = (chars: number): number => 0.57 * Math.max(1, chars) + 0.12;

export interface TraySlot { column: number; row: number; label: string; insertId: string | null }

export interface TrayLayout {
	columns: number;
	rows: number;
	single: boolean; // one insert: a small single case rather than a tray
	pitch: number;
	width: number; // x extent of the tray
	depth: number; // z extent
	pocketW: number;
	pocketD: number;
	floorY: number; // top of the pocket floor
	topY: number; // top of the tray
	insertY: number; // mid-thickness of an insert resting in a pocket
	sideRoom: number; // tray from a pocket's outer edge to the tray's side, in the first and last column: the etched number's room
	endRoom: number; // tray from the first row's back edge, and the last row's front edge, to the tray's end: the title lines' room
	numberH: number; // the height of an etched slot number
	endH: number; // the most the near end's title line's height can be
	endHTop: number; // ... and the far end's, taller to offset its foreshortening and distance
	slots: TraySlot[];
	slotOf: Map<string, TraySlot>;
	centre(column: number, row: number): { x: number; z: number };
}

// The one-insert case: one slot (the insert's number, or ?), the case just the pocket and a wall.
function singleCase(model: ToolingModel, pocketW: number, pocketD: number, pitch: number, thicknessMm: number): TrayLayout {
	const insert = model.inserts[0];
	const slot: TraySlot = { column: 0, row: 0, label: insert.number !== null ? String(insert.number) : '?', insertId: insert.id };
	return {
		columns: 1, rows: 1, single: true, pitch, width: pocketW + 2 * CASE_WALL_MM, depth: pocketD + 2 * CASE_WALL_MM,
		pocketW, pocketD, floorY: FLOOR_MM, topY: FLOOR_MM + POCKET_DEPTH_MM,
		insertY: FLOOR_MM + 0.15 + thicknessMm / 2, sideRoom: CASE_WALL_MM, endRoom: CASE_WALL_MM,
		numberH: Math.min(CASE_WALL_MM * NUMBER_FRONT_SHARE, pocketW * NUMBER_H_SHARE),
		endH: Math.min(CASE_WALL_MM * NUMBER_FRONT_SHARE, pocketW * END_H_SHARE),
		endHTop: Math.min(CASE_WALL_MM * NUMBER_FRONT_SHARE, pocketW * END_H_SHARE),
		slots: [slot], slotOf: new Map([[insert.id, slot]]), centre: () => ({ x: 0, z: 0 }),
	};
}

export function trayLayout(model: ToolingModel): TrayLayout {
	const g = model.geometry;
	const xs = model.outline.points.map((p) => p[0]);
	const ys = model.outline.points.map((p) => p[1]);
	const halfW = Math.max(...xs.map(Math.abs), g.icMm / 2);
	const halfD = Math.max(...ys.map(Math.abs), g.icMm / 2);
	const single = model.inserts.length === 1;
	const pocketMargin = single ? CASE_POCKET_MARGIN_MM : POCKET_MARGIN_MM;
	const pocketW = 2 * halfW + pocketMargin;
	const pocketD = 2 * halfD + pocketMargin;
	const pitch = single ? Math.max(pocketW, pocketD) : Math.max(1.7 * g.icMm, Math.max(pocketW, pocketD) + SLOT_GAP_MM);

	const slots: TraySlot[] = [];
	if (single) return singleCase(model, pocketW, pocketD, pitch, g.thicknessMm);
	const byNumber = new Map<number, string>();
	for (const i of model.inserts) if (i.cell) byNumber.set(i.cell.number, i.id);
	for (const c of model.grid.cells) {
		slots.push({ column: c.column, row: c.row, label: String(c.number), insertId: byNumber.get(c.number) ?? null });
	}
	// Inserts without a slot number go into extra pockets after the grid, so they stay visible and selectable.
	const columns = model.grid.columns;
	let next = slots.length;
	for (const i of model.inserts) {
		if (i.cell) continue;
		slots.push({ column: next % columns, row: Math.floor(next / columns), label: '?', insertId: i.id });
		next++;
	}
	const rows = Math.max(1, Math.ceil(Math.max(next, 1) / columns), model.grid.rows);

	const margin = pitch * 0.3;
	// The outer columns' numbers sit in the tray's side margins and an inner column's in front of its pocket, so the
	// numbers are as tall as the pocket allows, but never taller than the strip in front of an inner pocket. The box
	// code and the insert type are etched across the ends. The margins are widened, if need be, until the widest number
	// fits beside a pocket and the title lines fit past the last row's (inner) numbers, each with a hair to spare.
	const longest = Math.max(1, ...slots.map((s) => s.label.length));
	const numberH = columns > 2 ? Math.min(pocketW * NUMBER_H_SHARE, (pitch - pocketD) * NUMBER_FRONT_SHARE) : pocketW * NUMBER_H_SHARE;
	const endH = Math.min(numberH, pocketW * END_H_SHARE);
	const endHTop = endH * FAR_END_SCALE;
	const sideMargin = Math.max(margin, numberH * numberAspect(longest) + 2 * TEXT_PAD_MM - (pitch - pocketW) / 2);
	const endMargin = Math.max(margin, endHTop + 2 * TEXT_PAD_MM - (pitch - pocketD) / 2, columns > 2 ? numberH / 2 + endH + 2 * TEXT_PAD_MM : 0);
	const width = columns * pitch + 2 * sideMargin;
	const depth = rows * pitch + 2 * endMargin;
	const slotOf = new Map<string, TraySlot>();
	for (const s of slots) if (s.insertId) slotOf.set(s.insertId, s);
	return {
		columns, rows, single: false, pitch, width, depth, pocketW, pocketD,
		floorY: FLOOR_MM,
		topY: FLOOR_MM + POCKET_DEPTH_MM,
		insertY: FLOOR_MM + 0.15 + g.thicknessMm / 2,
		sideRoom: (pitch - pocketW) / 2 + sideMargin, endRoom: (pitch - pocketD) / 2 + endMargin, numberH, endH, endHTop,
		slots, slotOf,
		centre: (column, row) => ({ x: (column - (columns - 1) / 2) * pitch, z: (row - (rows - 1) / 2) * pitch }),
	};
}

export function slotPosition(layout: TrayLayout, slot: TraySlot): { x: number; y: number; z: number } {
	const c = layout.centre(slot.column, slot.row);
	return { x: c.x, y: layout.insertY, z: c.z };
}

function roundedRect(shape: Shape | Path, cx: number, cy: number, w: number, h: number, r: number): void {
	const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
	const k = Math.min(r, w / 2, h / 2);
	shape.moveTo(x0 + k, y0);
	shape.lineTo(x1 - k, y0);
	shape.quadraticCurveTo(x1, y0, x1, y0 + k);
	shape.lineTo(x1, y1 - k);
	shape.quadraticCurveTo(x1, y1, x1 - k, y1);
	shape.lineTo(x0 + k, y1);
	shape.quadraticCurveTo(x0, y1, x0, y1 - k);
	shape.lineTo(x0, y0 + k);
	shape.quadraticCurveTo(x0, y0, x0 + k, y0);
}

// A slab from y0 to y0 + height with a softly bevelled rim, shape in the xz plane (shape y = -z).
function slab(shape: Shape, y0: number, height: number): BufferGeometry {
	const g = new ExtrudeGeometry(shape, {
		depth: height - 2 * TRAY_BEVEL_MM, bevelEnabled: true, bevelThickness: TRAY_BEVEL_MM,
		bevelSize: TRAY_BEVEL_MM, bevelOffset: -TRAY_BEVEL_MM, bevelSegments: 2, curveSegments: 8,
	});
	g.rotateX(-Math.PI / 2);
	g.translate(0, y0 + TRAY_BEVEL_MM, 0);
	return g;
}

// The slab: a solid floor plus the pocketed layer on top of it, merged into one geometry.
export function buildTrayGeometry(layout: TrayLayout): BufferGeometry {
	const radius = Math.min(layout.pitch * 0.18, 5);
	const outer = (): Shape => {
		const s = new Shape();
		roundedRect(s, 0, 0, layout.width, layout.depth, radius);
		return s;
	};
	const floor = slab(outer(), 0, FLOOR_MM);
	const layer = outer();
	for (const s of layout.slots) {
		const c = layout.centre(s.column, s.row);
		const hole = new Path();
		roundedRect(hole, c.x, -c.z, layout.pocketW, layout.pocketD, 1.6);
		layer.holes.push(hole);
	}
	const pockets = slab(layer, FLOOR_MM, POCKET_DEPTH_MM);
	const merged = mergeGeometries([floor, pockets], false);
	floor.dispose();
	pockets.dispose();
	return merged;
}

// The state ring of a pocket: a flat frame on the pocket floor around the insert, centred on the slot.
export function buildPocketRingGeometry(layout: TrayLayout): BufferGeometry {
	const w = layout.pocketW - 0.3;
	const d = layout.pocketD - 0.3;
	const shape = new Shape();
	roundedRect(shape, 0, 0, w, d, 1.4);
	const hole = new Path();
	roundedRect(hole, 0, 0, w - 2 * RING_WIDTH_MM, d - 2 * RING_WIDTH_MM, 0.8);
	shape.holes.push(hole);
	const g = new ShapeGeometry(shape, 6);
	g.rotateX(-Math.PI / 2);
	g.translate(0, layout.floorY + RING_LIFT_MM, 0);
	return g;
}
