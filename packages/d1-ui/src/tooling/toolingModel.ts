// The one object the tooling view draws: a tool box with its geometry, tray grid, inserts and edges,
// plus the small rules around it (insert state, the next fresh edge, focus navigation).

import { recordRoute } from '../recordRoute';
import { slotGrid, type SlotCell, type SlotGrid } from './boxLayout';
import { normaliseEdgeLetter, placeEdge, type EdgePlacement } from './edgePlacement';
import { insertOutline, resolveInsertGeometry, type InsertGeometry, type InsertOutline, type InsertTypeRow } from './insertGeometry';

// The columns of each collection that the model needs (db/schema.sql). Extra fields are fine.
export interface BoxRow { tool_box_id: string; tool_box_code: string; [k: string]: unknown }
export interface InsertRow {
	insert_id: string; insert_code: string; tool_box_id?: string | null;
	insert_number: number | null; is_depleted: boolean | null; notes?: string | null; location?: string | null;
	[k: string]: unknown;
}
export interface EdgeRow {
	edge_id: string; edge_code: string; insert_id: string;
	edge_identifier: string | null; is_used: boolean | null; notes?: string | null;
	[k: string]: unknown;
}

export type InsertState = 'fresh' | 'partly-used' | 'used' | 'depleted';

export interface ToolingEdge {
	id: string; code: string; identifier: string; // raw edge_identifier
	letter: string | null; // normalised ('fC' -> 'C'); null if unreadable
	used: boolean; notes: string | null;
	placement: EdgePlacement | null; // null -> "position unknown"
}

export interface ToolingInsert {
	id: string; code: string; number: number | null; depleted: boolean;
	state: InsertState; edges: ToolingEdge[]; // edges sorted by letter, one per letter
	// How many edges the insert type has (edges per face x faces), or null when the type is not known. Legacy imports can
	// leave an insert with fewer edge rows than that, or with two rows for one letter.
	expectedEdges: number | null;
	duplicateEdges: string[]; // ids of extra edge rows for a letter already on `edges`: never drawn, never counted
	cell: SlotCell | null; // null when the number is missing or out of the grid
}

// What an insert's edge count reads: "3/4 fresh" is `fresh` of `total`. `total` is the type's edge count (or the recorded
// edges, if there are more), so a missing edge still counts as one the insert should have, and is never fresh.
export interface EdgeSummary { fresh: number; total: number; missing: number; duplicates: number }

export function edgeSummary(insert: Pick<ToolingInsert, 'edges' | 'expectedEdges' | 'duplicateEdges'>): EdgeSummary {
	const total = Math.max(insert.edges.length, insert.expectedEdges ?? 0);
	return {
		fresh: insert.edges.filter((e) => !e.used).length,
		total,
		missing: total - insert.edges.length,
		duplicates: insert.duplicateEdges.length,
	};
}

// The notes the insert panel shows under the edges: "1 edge missing", "1 duplicate edge record ignored".
export function edgeNotes(insert: Pick<ToolingInsert, 'edges' | 'expectedEdges' | 'duplicateEdges'>): string[] {
	const { missing, duplicates } = edgeSummary(insert);
	const out: string[] = [];
	if (missing > 0) out.push(`${missing} ${missing === 1 ? 'edge' : 'edges'} missing`);
	if (duplicates > 0) out.push(`${duplicates} duplicate edge ${duplicates === 1 ? 'record' : 'records'} ignored`);
	return out;
}

export interface ToolingModel {
	boxId: string; boxCode: string;
	typeCode: string | null; // the insert type's code (else its ISO designation), for the label on the tray; null when unknown
	geometry: InsertGeometry; outline: InsertOutline;
	grid: SlotGrid; inserts: ToolingInsert[]; // sorted by number
}

export type ToolingFocus =
	| { kind: 'box' }
	| { kind: 'insert'; insertId: string }
	| { kind: 'edge'; insertId: string; edgeId: string };

// A slot number beyond this is treated as a typo, not a request for a huge tray.
const MAX_SLOT_NUMBER = 200;

// `expected` is the type's edge count: an insert is used only when every one of its edges is, so a missing edge keeps a
// part-used insert part used.
export function insertState(insert: { is_depleted: boolean | null }, edges: { is_used: boolean | null }[], expected: number | null = null): InsertState {
	if (insert.is_depleted) return 'depleted';
	const used = edges.filter((e) => e.is_used).length;
	if (used === 0) return 'fresh';
	return used >= Math.max(edges.length, expected ?? 0) ? 'used' : 'partly-used';
}

// One row per letter: of several rows for the same letter (a legacy import), the one that has been used, else the first by
// code. Rows whose letter cannot be read are all kept. The rest come back as `dropped`.
export function dedupeEdges(rows: ToolingEdge[]): { kept: ToolingEdge[]; dropped: ToolingEdge[] } {
	const byLetterKey = new Map<string, ToolingEdge[]>();
	const kept: ToolingEdge[] = [];
	for (const e of rows) {
		if (e.letter === null) { kept.push(e); continue; }
		const list = byLetterKey.get(e.letter);
		if (list) list.push(e);
		else byLetterKey.set(e.letter, [e]);
	}
	const dropped: ToolingEdge[] = [];
	for (const list of byLetterKey.values()) {
		const ranked = [...list].sort((a, b) => Number(b.used) - Number(a.used) || a.code.localeCompare(b.code));
		kept.push(ranked[0]);
		dropped.push(...ranked.slice(1));
	}
	return { kept, dropped };
}

// How many edges an insert of this geometry has: per face, times the faces. Null when the type is not recognised (the
// fallback polygon is a guess).
export function expectedEdgeCount(geometry: InsertGeometry): number | null {
	return geometry.recognised ? geometry.edgesPerFace * (geometry.doubleSided ? 2 : 1) : null;
}

const byLetter = (a: ToolingEdge, b: ToolingEdge): number => {
	if (a.letter === b.letter) return a.code.localeCompare(b.code);
	if (a.letter === null) return 1;
	if (b.letter === null) return -1;
	return a.letter < b.letter ? -1 : 1;
};

const validSlot = (n: number | null): n is number => n !== null && Number.isInteger(n) && n >= 1 && n <= MAX_SLOT_NUMBER;

// The name of the insert type: its type_code, trimmed, else its iso_designation, else null.
export function insertTypeCode(type: InsertTypeRow | null): string | null {
	for (const v of [type?.type_code, type?.iso_designation]) {
		const t = typeof v === 'string' ? v.trim() : '';
		if (t) return t;
	}
	return null;
}

export function buildToolingModel(box: BoxRow, type: InsertTypeRow | null, inserts: InsertRow[], edges: EdgeRow[]): ToolingModel {
	const geometry = resolveInsertGeometry(type);
	const outline = insertOutline(geometry);

	const edgesOf = new Map<string, ToolingEdge[]>();
	for (const e of edges) {
		const letter = normaliseEdgeLetter(e.edge_identifier);
		const row: ToolingEdge = {
			id: e.edge_id, code: e.edge_code, identifier: e.edge_identifier ?? '', letter,
			used: e.is_used === true, notes: e.notes ?? null, placement: placeEdge(geometry, letter),
		};
		const list = edgesOf.get(e.insert_id);
		if (list) list.push(row);
		else edgesOf.set(e.insert_id, [row]);
	}

	const numberOf = (i: InsertRow): number | null => (typeof i.insert_number === 'number' && Number.isFinite(i.insert_number) ? i.insert_number : null);
	const sorted = [...inserts].sort((a, b) => {
		const na = numberOf(a);
		const nb = numberOf(b);
		if (na !== nb) return na === null ? 1 : nb === null ? -1 : na - nb;
		return a.insert_code.localeCompare(b.insert_code);
	});

	const highest = sorted.reduce((m, i) => {
		const n = numberOf(i);
		return validSlot(n) ? Math.max(m, n) : m;
	}, 0);
	const grid = slotGrid(Math.max(sorted.length, highest));

	const expected = expectedEdgeCount(geometry);
	const taken = new Set<number>();
	const modelInserts = sorted.map((i): ToolingInsert => {
		const n = numberOf(i);
		let cell: SlotCell | null = null;
		if (validSlot(n) && !taken.has(n)) {
			taken.add(n);
			cell = grid.cells[n - 1] ?? null;
		}
		const { kept, dropped } = dedupeEdges(edgesOf.get(i.insert_id) ?? []);
		const own = kept.sort(byLetter);
		return {
			id: i.insert_id, code: i.insert_code, number: n, depleted: i.is_depleted === true,
			state: insertState({ is_depleted: i.is_depleted === true }, own.map((e) => ({ is_used: e.used })), expected), edges: own,
			expectedEdges: expected, duplicateEdges: dropped.map((e) => e.id).sort(), cell,
		};
	});

	return { boxId: box.tool_box_id, boxCode: box.tool_box_code, typeCode: insertTypeCode(type), geometry, outline, grid, inserts: modelInserts };
}

// Spec Q10: the lowest-numbered non-depleted insert that already has a used edge (and still a fresh
// one), at its first fresh letter; if none is part-used, the lowest-numbered insert with a fresh edge.
export function nextFreshEdge(model: ToolingModel): { insertId: string; edgeId: string } | null {
	const firstFresh = (i: ToolingInsert) => i.edges.find((e) => !e.used);
	const pick = (candidates: ToolingInsert[]) => {
		for (const i of candidates) {
			const fresh = firstFresh(i);
			if (fresh) return { insertId: i.id, edgeId: fresh.id };
		}
		return null;
	};
	const live = model.inserts.filter((i) => !i.depleted);
	return pick(live.filter((i) => i.state === 'partly-used')) ?? pick(live);
}

export function edgeUsageMismatch(used: boolean, historyCount: number): 'unused-with-history' | null {
	return !used && historyCount > 0 ? 'unused-with-history' : null;
}

export function focusParent(focus: ToolingFocus): ToolingFocus | null {
	if (focus.kind === 'edge') return { kind: 'insert', insertId: focus.insertId };
	if (focus.kind === 'insert') return { kind: 'box' };
	return null;
}

export function focusRoute(focus: ToolingFocus, boxId: string): string {
	if (focus.kind === 'edge') return recordRoute('insert_edges', focus.edgeId);
	if (focus.kind === 'insert') return recordRoute('cutting_inserts', focus.insertId);
	return recordRoute('tool_boxes', boxId);
}
