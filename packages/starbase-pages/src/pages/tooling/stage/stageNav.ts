// Keyboard navigation and the words on the stage. Pure, so it is tested without a browser.

import { edgeSummary, focusParent, type ToolingEdge, type ToolingFocus, type ToolingModel } from '@d1/ui';
import type { PickTarget } from './scene/pick';

// "3", or the insert's code when it has no slot number.
function insertName(model: ToolingModel, insertId: string): string {
	const i = model.inserts.find((x) => x.id === insertId);
	if (!i) return '?';
	return i.number !== null ? String(i.number) : i.code;
}

// Hover label: "Insert 3 · 2/4 fresh", "Insert 3 · depleted", "Edge 3B · used".
export function hoverLabel(model: ToolingModel, target: PickTarget): string {
	const insert = model.inserts.find((i) => i.id === target.insertId);
	if (!insert) return '';
	if (target.kind === 'edge') {
		const e = insert.edges.find((x) => x.id === target.edgeId);
		if (!e) return '';
		return `Edge ${insertName(model, insert.id)}${e.letter ?? e.identifier} · ${e.used ? 'used' : 'fresh'}`;
	}
	const name = `Insert ${insertName(model, insert.id)}`;
	if (insert.depleted) return `${name} · depleted`;
	if (insert.edges.length === 0) return `${name} · no edges`;
	const { fresh, total } = edgeSummary(insert);
	return `${name} · ${fresh}/${total} fresh`;
}

// What a screen reader hears when the focus moves: "Insert 3, 2 of 4 edges fresh", "Edge 3B, used, top face".
export function focusAnnouncement(model: ToolingModel, focus: ToolingFocus): string {
	if (focus.kind === 'box') {
		const n = model.inserts.length;
		return `Tool box${model.boxCode ? ` ${model.boxCode}` : ''}, ${n} ${n === 1 ? 'insert' : 'inserts'}`;
	}
	const insert = model.inserts.find((i) => i.id === focus.insertId);
	if (!insert) return '';
	const name = insertName(model, insert.id);
	if (focus.kind === 'insert') {
		if (insert.depleted) return `Insert ${name}, depleted`;
		if (insert.edges.length === 0) return `Insert ${name}, no edges`;
		const { fresh, total } = edgeSummary(insert);
		return `Insert ${name}, ${fresh} of ${total} edges fresh`;
	}
	const e = insert.edges.find((x) => x.id === focus.edgeId);
	if (!e) return '';
	return `Edge ${name}${e.letter ?? e.identifier}, ${e.used ? 'used' : 'fresh'}, ${placementWords(e)}`;
}

const placementWords = (e: ToolingEdge): string => (!e.placement ? 'position unknown' : e.placement.face === 'top' ? 'top face' : 'underside');

// Edges of the focused insert that have no place on the drawing: listed as chips, still selectable.
export function unplacedEdges(model: ToolingModel, focus: ToolingFocus): ToolingEdge[] {
	if (focus.kind === 'box') return [];
	return model.inserts.find((i) => i.id === focus.insertId)?.edges.filter((e) => e.placement === null) ?? [];
}

export type NavKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'PageUp' | 'PageDown';
export const NAV_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'];

// Arrow keys step through inserts (box focus) or edges (insert and edge focus); Page Up and Page Down,
// or Shift with an arrow, step to the previous and next insert from inside one. Null: nothing to move to.
export function stepFocus(model: ToolingModel, focus: ToolingFocus, key: NavKey, shift = false): ToolingFocus | null {
	const forward = key === 'ArrowRight' || key === 'ArrowDown' || key === 'PageDown';
	const sideways = key === 'PageUp' || key === 'PageDown' || shift;
	const inserts = model.inserts;
	// The neighbour of position `at` in a list; with nothing current (-1), the first going forward or the last going back.
	const neighbour = <T>(list: readonly T[], at: number): T | null => {
		if (list.length === 0) return null;
		if (at < 0) return forward ? list[0] : list[list.length - 1];
		const next = at + (forward ? 1 : -1);
		return next < 0 || next >= list.length ? null : list[next];
	};

	if (focus.kind === 'box') {
		const i = neighbour(inserts, -1);
		return i ? { kind: 'insert', insertId: i.id } : null;
	}
	const at = inserts.findIndex((i) => i.id === focus.insertId);
	if (at < 0) return null;
	if (sideways) {
		const i = neighbour(inserts, at);
		return i ? { kind: 'insert', insertId: i.id } : null;
	}
	const edges = inserts[at].edges;
	const edgeAt = focus.kind === 'edge' ? edges.findIndex((e) => e.id === focus.edgeId) : -1;
	const e = neighbour(edges, edgeAt);
	return e ? { kind: 'edge', insertId: focus.insertId, edgeId: e.id } : null;
}

// Esc: up one level.
export function escapeFocus(focus: ToolingFocus): ToolingFocus | null {
	return focusParent(focus);
}

// 3D needs room: the stage itself at least this wide and tall (px). A smaller one gets the 2D grid.
export const MIN_3D_WIDTH = 260;
export const MIN_3D_HEIGHT = 360;
export const stageFits3d = (width: number, height: number): boolean => width >= MIN_3D_WIDTH && height >= MIN_3D_HEIGHT;
