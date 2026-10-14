// What the tooling record page shows around the 3D stage, as pure functions: which record the route
// names, the counts and labels of the panels, and an edge's history (tests and operations merged).
// ToolingPage and its panels only draw what these return.

import { operationLabel } from '../operationLabel';
import type { InsertState, ToolingEdge, ToolingFocus, ToolingInsert, ToolingModel } from './toolingModel';
import { edgeUsageMismatch } from './toolingModel';

export type FocusKind = ToolingFocus['kind'];

/** The route's `:kind` segment is the collection's page: /tool-boxes/:id, /inserts/:id, /edges/:id. */
const KIND_OF_SEGMENT = new Map<string, FocusKind>([['tool-boxes', 'box'], ['inserts', 'insert'], ['edges', 'edge']]);
export function focusKindOf(segment: string | null | undefined): FocusKind | null {
	return (segment && KIND_OF_SEGMENT.get(segment)) || null;
}

export const FOCUS_COLLECTION: Record<FocusKind, string> = { box: 'tool_boxes', insert: 'cutting_inserts', edge: 'insert_edges' };
export const FOCUS_KIND_LABEL: Record<FocusKind, string> = { box: 'Tool box', insert: 'Cutting insert', edge: 'Insert edge' };
export const FOCUS_NOUN: Record<FocusKind, string> = { box: 'tool box', insert: 'cutting insert', edge: 'insert edge' };

export const STATE_ORDER: InsertState[] = ['fresh', 'partly-used', 'used', 'depleted'];
export const STATE_LABEL: Record<InsertState, string> = { fresh: 'Fresh', 'partly-used': 'Partly used', used: 'Used', depleted: 'Depleted' };

export function stateCounts(model: ToolingModel): Record<InsertState, number> {
	const out: Record<InsertState, number> = { fresh: 0, 'partly-used': 0, used: 0, depleted: 0 };
	for (const i of model.inserts) out[i.state]++;
	return out;
}

export function findInsert(model: ToolingModel | null, insertId: string): ToolingInsert | null {
	return model?.inserts.find((i) => i.id === insertId) ?? null;
}

export function findEdge(model: ToolingModel | null, edgeId: string): { insert: ToolingInsert; edge: ToolingEdge } | null {
	for (const insert of model?.inserts ?? []) {
		const edge = insert.edges.find((e) => e.id === edgeId);
		if (edge) return { insert, edge };
	}
	return null;
}

/**
 * The stage's focus for a route. An edge's insert comes from the loaded model (instant, so moving
 * between edges of one box never waits for a read), else from the edge record's own `insert_id`.
 * Null while neither is known, and for a kind that is not a tooling page.
 */
export function focusFromRoute(segment: string, id: string, model: ToolingModel | null, edgeInsertId: string | null): ToolingFocus | null {
	const kind = focusKindOf(segment);
	if (!kind || !id) return null;
	if (kind === 'box') return { kind: 'box' };
	if (kind === 'insert') return { kind: 'insert', insertId: id };
	const insertId = findEdge(model, id)?.insert.id ?? edgeInsertId;
	return insertId ? { kind: 'edge', insertId, edgeId: id } : null;
}

export const insertLabel = (i: ToolingInsert): string => (i.number !== null ? `Insert ${i.number}` : i.code);
/** "3B": the insert's slot number and the edge letter; the edge's code when either is missing. */
export const edgeLabel = (i: ToolingInsert, e: ToolingEdge): string => (i.number !== null && e.letter ? `${i.number}${e.letter}` : e.code);

/** The header bar's title: "Tool box BOX-…", "Insert CNMG12-1-3", "Edge CNMG12-1-3B". */
export function toolingTitle(focus: ToolingFocus | null, model: ToolingModel | null): string {
	if (!focus || !model) return 'Tooling';
	if (focus.kind === 'box') return `Tool box ${model.boxCode}`.trim();
	if (focus.kind === 'insert') {
		const i = findInsert(model, focus.insertId);
		return i ? `Insert ${i.code}` : 'Insert';
	}
	const hit = findEdge(model, focus.edgeId);
	return hit ? `Edge ${hit.edge.code}` : 'Edge';
}

export function mismatchText(count: number): string {
	return `Marked fresh, but ${count} ${count === 1 ? 'test or operation' : 'tests or operations'} used this edge.`;
}

export interface FreshWithHistory { insert: ToolingInsert; edge: ToolingEdge; count: number }

/** Edges marked fresh that tests or operations have used (`counts` is history rows per edge id). Spec Q6: `is_used` is the truth, so these are warnings only. */
export function freshWithHistory(model: ToolingModel, counts: ReadonlyMap<string, number>): FreshWithHistory[] {
	const out: FreshWithHistory[] = [];
	for (const insert of model.inserts) {
		for (const edge of insert.edges) {
			const count = counts.get(edge.id) ?? 0;
			if (edgeUsageMismatch(edge.used, count)) out.push({ insert, edge, count });
		}
	}
	return out;
}

export interface HistoryEntry {
	kind: 'test' | 'operation';
	id: string;
	collection: 'test_sessions' | 'manufacturing_operations';
	date: string | null;
	label: string;
	sampleCode: string | null;
	status: string | null;
	category: string | null;
}

const time = (d: string | null): number => {
	const t = d ? Date.parse(d) : NaN;
	return Number.isNaN(t) ? -Infinity : t;
};
const sampleCodeOf = (row: any): string | null => {
	const code = row?.sample_id?.sample_code;
	return typeof code === 'string' && code.trim() ? code.trim() : null;
};

/** An edge's tests and operations as one list, newest first, undated last. */
export function mergeHistory(tests: ReadonlyArray<any>, operations: ReadonlyArray<any>): HistoryEntry[] {
	const entries: HistoryEntry[] = [
		...tests.map((t): HistoryEntry => ({
			kind: 'test', id: t.session_id, collection: 'test_sessions', date: t.session_date ?? null,
			label: t.test_type || 'Test', sampleCode: sampleCodeOf(t), status: t.status ?? null, category: null,
		})),
		...operations.map((o): HistoryEntry => ({
			kind: 'operation', id: o.operation_id, collection: 'manufacturing_operations', date: o.operation_date ?? null,
			label: operationLabel(o), sampleCode: sampleCodeOf(o), status: null, category: o.process_category ?? null,
		})),
	];
	return entries.sort((a, b) => time(b.date) - time(a.date));
}
