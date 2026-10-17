// The 2D insert view: ONE large insert outline with its edge letters on the face being shown, a Top | Underside choice for a
// double-sided insert, a chip per edge so every letter is reachable without turning the insert over, and a line of facts.
// Pure, no three.js: this file is in the entry chunk.

import type { EdgePlacement, InsertGeometry, ToolingEdge, ToolingFocus, ToolingInsert, ToolingModel } from '@d1/ui';
import { outline2d, type Outline2D } from './outline2d';

export type Face = EdgePlacement['face'];

export const FACE_LABEL: Record<Face, string> = { top: 'Top', bottom: 'Underside' };
export const UNDERSIDE_CAPTION = 'Underside, drawn mirrored left to right, as if the insert were turned over.';

// The face the view shows: the one holding the selected edge, else the face asked for (the top at first). A single-sided
// insert only has the top.
export function faceToShow(insert: ToolingInsert, geom: InsertGeometry, focus: ToolingFocus, chosen: Face): Face {
	if (!geom.doubleSided) return 'top';
	if (focus.kind === 'edge') {
		const e = insert.edges.find((x) => x.id === focus.edgeId);
		if (e?.placement) return e.placement.face;
	}
	return chosen;
}

export interface Pill {
	edge: ToolingEdge;
	letter: string;
	x: number; y: number;
	used: boolean;
	selected: boolean;
	next: boolean;
	name: string; // the accessible name, "Edge C, fresh, underside"
}

export const edgeName = (e: ToolingEdge, nextEdgeId: string | null): string =>
	`Edge ${e.letter ?? (e.identifier || '?')}, ${e.used ? 'used' : 'fresh'}${e.placement?.face === 'bottom' ? ', underside' : ''}${e.id === nextEdgeId ? ', next fresh edge' : ''}`;

// The letters on the corners of the face shown (an edge with no place on the drawing is only a chip).
export function facePills(model: ToolingModel, insert: ToolingInsert, face: Face, drawing: Outline2D, focus: ToolingFocus, nextEdgeId: string | null): Pill[] {
	return insert.edges.filter((e) => e.placement?.face === face).map((e) => {
		const at = drawing.nose(e.placement!.corner);
		return {
			edge: e, letter: e.letter ?? e.identifier, x: at.x, y: at.y, used: e.used, next: e.id === nextEdgeId,
			selected: focus.kind === 'edge' && focus.edgeId === e.id, name: edgeName(e, nextEdgeId),
		};
	});
}

export interface Chip { edge: ToolingEdge; text: string; used: boolean; selected: boolean; next: boolean; name: string; face: Face | null }

// One chip per edge, in letter order: "A ● fresh", "C used". The face is noted for an underside edge.
export function edgeChips(insert: ToolingInsert, focus: ToolingFocus, nextEdgeId: string | null): Chip[] {
	return insert.edges.map((e) => ({
		edge: e, text: `${e.letter ?? (e.identifier || '?')}${e.placement?.face === 'bottom' ? ' (under)' : ''}`, used: e.used,
		selected: focus.kind === 'edge' && focus.edgeId === e.id, next: e.id === nextEdgeId, name: edgeName(e, nextEdgeId),
		face: e.placement?.face ?? null,
	}));
}

const ROUND = (n: number): string => (Math.round(n * 100) / 100).toString();

// "CNMG 12 04 08, 80° rhombus, IC 12.7 mm, 2 cutting corners per face": the type and its shape, from the geometry the model
// already holds.
export function insertFacts(model: ToolingModel): string {
	const g = model.geometry;
	const shape =
		g.shape === 'rect' ? `${ROUND(g.lengthMm ?? g.icMm)} x ${ROUND(g.icMm)} mm rectangle`
			: g.shape === 'polygon' ? `${g.cornerCount}-sided polygon (shape not recognised)`
				: g.shape === 'R' ? 'round'
					: g.shape === 'S' ? 'square'
						: g.shape === 'T' ? 'triangle'
							: g.shape === 'W' ? 'trigon'
								: `${ROUND(g.includedAngleDeg)}° rhombus`;
	const size = g.shape === 'rect' ? '' : `, IC ${ROUND(g.icMm)} mm`;
	const n = g.cuttingCorners.length;
	const corners = `${n} cutting ${n === 1 ? 'corner' : 'corners'} per face`;
	return [model.typeCode, shape].filter(Boolean).join(', ') + `${size}, ${corners}`;
}

export interface InsertView {
	face: Face;
	doubleSided: boolean;
	drawing: Outline2D;
	pills: Pill[];
	chips: Chip[];
	facts: string;
	caption: string | null; // under the drawing: the underside is mirrored
}

export function buildInsertView(model: ToolingModel, insert: ToolingInsert, focus: ToolingFocus, nextEdgeId: string | null, chosen: Face): InsertView {
	const face = faceToShow(insert, model.geometry, focus, chosen);
	const drawing = outline2d(model.geometry, model.outline, face);
	return {
		face, doubleSided: model.geometry.doubleSided, drawing,
		pills: facePills(model, insert, face, drawing, focus, nextEdgeId),
		chips: edgeChips(insert, focus, nextEdgeId),
		facts: insertFacts(model),
		caption: face === 'bottom' ? UNDERSIDE_CAPTION : null,
	};
}
