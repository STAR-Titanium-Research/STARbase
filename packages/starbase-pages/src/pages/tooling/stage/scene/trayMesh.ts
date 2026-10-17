// The tool box tray's geometry (slab, shallow pockets, state rings); the layout it is built from is in trayLayout.ts.
// World space: y up, the tray's bottom at y = 0, its centre on the y axis; slot (0, 0) is at the back left
// (-z is "up" on screen for the default camera), so the numbers read left to right, then toward the camera.

import { ExtrudeGeometry, Path, Shape, ShapeGeometry, type BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { FLOOR_MM, POCKET_DEPTH_MM, type TrayLayout } from './trayLayout';

export {
	FLOOR_MM, numberAspect, POCKET_DEPTH_MM, slotPosition, trayLayout, type TrayLayout, type TraySlot,
} from './trayLayout';

const TRAY_BEVEL_MM = 0.25;
const RING_LIFT_MM = 0.03;
export const RING_WIDTH_MM = 0.7;

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
