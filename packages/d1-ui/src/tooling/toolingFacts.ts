// The label/value facts of the tooling record page: the rail's key facts and the Details panel of a
// tool box, a cutting insert and an insert edge, plus the insert type's facts. Pure, so the page stays
// a layout. Rows are the `/items` reads of useToolingData (nested relations expanded).

import { formatDate } from '../format';
import type { Fact } from '../record/facts';
import { recordRoute } from '../recordRoute';
import type { InsertGeometry } from './insertGeometry';
import type { ToolingEdge } from './toolingModel';

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const yesNo = (v: unknown): string => (v ? 'Yes' : 'No');
const stamp = (v: unknown): string => (typeof v === 'string' ? formatDate(v) : '');
const num = (v: unknown): number | null => {
	const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
	return Number.isFinite(n) ? n : null;
};

/** Where an edge sits, in words: the face and its corner, or why it has no place on the drawing. */
export function placementText(edge: Pick<ToolingEdge, 'placement' | 'letter'>): string {
	if (!edge.placement) return edge.letter ? 'Position unknown' : 'No edge letter';
	return edge.placement.face === 'top' ? 'Top face' : 'Underside';
}

/**
 * The insert type's facts: ISO designation, maker, coating, substrate, class and edges per insert. `makerName` is the
 * `manufacturers` row's name, read on its own (a role may not read it); without it the type's `manufacturer` text is used.
 */
export function typeFacts(type: any, geometry?: InsertGeometry | null, makerName?: string | null): Fact[] {
	if (!type) return [];
	const maker = text(makerName) || text(type.manufacturer);
	const fromGeometry = geometry ? geometry.edgesPerFace * (geometry.doubleSided ? 2 : 1) : null;
	return [
		{ label: 'Type', value: text(type.type_code), mono: true },
		{ label: 'ISO designation', value: text(type.iso_designation), mono: true },
		{ label: 'Manufacturer', value: maker },
		{ label: 'Coating', value: text(type.coating) },
		{ label: 'Substrate', value: text(type.substrate) },
		{ label: 'Material class', value: text(type.material_class) },
		{ label: 'Edges per insert', value: num(type.edge_count) ?? fromGeometry },
		{ label: 'Inserts per box', value: num(type.inserts_per_box) },
	];
}

/** The rail of a tool box: its type, project, owner and place. */
export function boxRailFacts(box: any): Fact[] {
	if (!box) return [];
	const project = box.project_id;
	return [
		{ label: 'Insert type', value: text(box.insert_type_id?.type_code), mono: true },
		{ label: 'Project', value: project?.project_code ? `Project ${project.project_code}` : '', to: project?.project_id ? recordRoute('projects', project.project_id) : undefined },
		{ label: 'Owner', value: text(box.owner_person_id?.full_name) },
		{ label: 'Location', value: text(box.location) },
	];
}

export function boxDetailFacts(box: any): Fact[] {
	if (!box) return [];
	return [
		{ label: 'Description', value: text(box.description) },
		{ label: 'Quantity', value: num(box.package_quantity) },
		{ label: 'Created', value: stamp(box.created_at) },
		{ label: 'Updated', value: stamp(box.updated_at) },
	];
}

/** The rail of an insert: its box and slot, and where it is kept. */
export function insertRailFacts(insert: any, boxId: string, boxCode: string): Fact[] {
	if (!insert) return [];
	return [
		{ label: 'Tool box', value: boxCode, mono: true, to: recordRoute('tool_boxes', boxId) },
		{ label: 'Slot', value: num(insert.insert_number) },
		{ label: 'Location', value: text(insert.location) },
		{ label: 'Depleted', value: yesNo(insert.is_depleted) },
	];
}

export function insertDetailFacts(insert: any): Fact[] {
	if (!insert) return [];
	return [
		{ label: 'Created', value: stamp(insert.created_at) },
		{ label: 'Updated', value: stamp(insert.updated_at) },
	];
}

/** The rail of an edge: its insert and box, letter, position and whether it is marked used. */
export function edgeRailFacts(edge: any, model: { boxId: string; boxCode: string }, insert: { id: string; code: string }, modelEdge: ToolingEdge | null): Fact[] {
	if (!edge) return [];
	return [
		{ label: 'Tool box', value: model.boxCode, mono: true, to: recordRoute('tool_boxes', model.boxId) },
		{ label: 'Insert', value: insert.code, mono: true, to: recordRoute('cutting_inserts', insert.id) },
		{ label: 'Edge letter', value: modelEdge?.letter ?? text(edge.edge_identifier) },
		{ label: 'Position', value: modelEdge ? placementText(modelEdge) : '' },
		{ label: 'Marked used', value: yesNo(edge.is_used) },
	];
}

export function edgeDetailFacts(edge: any): Fact[] {
	if (!edge) return [];
	return [
		{ label: 'Identifier as recorded', value: text(edge.edge_identifier), mono: true },
		{ label: 'Created', value: stamp(edge.created_at) },
		{ label: 'Updated', value: stamp(edge.updated_at) },
	];
}
