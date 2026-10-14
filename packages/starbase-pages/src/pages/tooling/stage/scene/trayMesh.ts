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
const SLOT_GAP_MM = 3; // minimum wall between two pockets
const TRAY_BEVEL_MM = 0.25;
const RING_LIFT_MM = 0.03;

export interface TraySlot { column: number; row: number; label: string; insertId: string | null }

export interface TrayLayout {
	columns: number;
	rows: number;
	pitch: number;
	width: number; // x extent of the tray
	depth: number; // z extent
	pocketW: number;
	pocketD: number;
	floorY: number; // top of the pocket floor
	topY: number; // top of the tray
	insertY: number; // mid-thickness of an insert resting in a pocket
	slots: TraySlot[];
	slotOf: Map<string, TraySlot>;
	centre(column: number, row: number): { x: number; z: number };
}

export function trayLayout(model: ToolingModel): TrayLayout {
	const g = model.geometry;
	const xs = model.outline.points.map((p) => p[0]);
	const ys = model.outline.points.map((p) => p[1]);
	const halfW = Math.max(...xs.map(Math.abs), g.icMm / 2);
	const halfD = Math.max(...ys.map(Math.abs), g.icMm / 2);
	const pocketW = 2 * halfW + POCKET_MARGIN_MM;
	const pocketD = 2 * halfD + POCKET_MARGIN_MM;
	const pitch = Math.max(1.7 * g.icMm, Math.max(pocketW, pocketD) + SLOT_GAP_MM);

	const slots: TraySlot[] = [];
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
	const width = columns * pitch + 2 * margin;
	const depth = rows * pitch + 2 * margin;
	const slotOf = new Map<string, TraySlot>();
	for (const s of slots) if (s.insertId) slotOf.set(s.insertId, s);
	return {
		columns, rows, pitch, width, depth, pocketW, pocketD,
		floorY: FLOOR_MM,
		topY: FLOOR_MM + POCKET_DEPTH_MM,
		insertY: FLOOR_MM + 0.15 + g.thicknessMm / 2,
		slots, slotOf,
		centre: (column, row) => ({ x: (column - (columns - 1) / 2) * pitch, z: (row - (rows - 1) / 2) * pitch }),
	};
}

export function slotPosition(layout: TrayLayout, slot: TraySlot): { x: number; y: number; z: number } {
	const c = layout.centre(slot.column, slot.row);
	return { x: c.x, y: layout.insertY, z: c.z };
}

// The number pill of a slot sits on the front rim of its pocket.
export function slotLabelAnchor(layout: TrayLayout, slot: TraySlot): [number, number, number] {
	const c = layout.centre(slot.column, slot.row);
	return [c.x, layout.topY, c.z + layout.pocketD / 2 - 0.2];
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
