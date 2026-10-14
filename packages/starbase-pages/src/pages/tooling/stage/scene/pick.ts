// What a click or hover on the scene means. Pure: the scene hands in a hit's userData or instance id.

import type { ToolingFocus, ToolingModel } from '@d1/ui';

export type PickTarget =
	| { kind: 'insert'; insertId: string }
	| { kind: 'edge'; insertId: string; edgeId: string };

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

// A mesh's userData: { kind: 'insert', insertId } or { kind: 'edge', insertId, edgeId }.
// An edge only counts as an edge once its insert is the focused one; from the box, or from another
// insert, touching an edge selects its insert (the edges are too small to aim at from afar).
export function pickFromUserData(userData: unknown, focus: ToolingFocus): PickTarget | null {
	if (typeof userData !== 'object' || userData === null) return null;
	const u = userData as Record<string, unknown>;
	if (!str(u.insertId)) return null;
	if (u.kind === 'edge' && str(u.edgeId) && focus.kind !== 'box' && focus.insertId === u.insertId) {
		return { kind: 'edge', insertId: u.insertId, edgeId: u.edgeId };
	}
	if (u.kind === 'insert' || u.kind === 'edge') return { kind: 'insert', insertId: u.insertId };
	return null;
}

// An instanced mesh hit: the instance id indexes the ids the mesh was filled with.
export function pickFromInstance(ids: readonly string[], instanceId: number | undefined): PickTarget | null {
	if (instanceId === undefined || !Number.isInteger(instanceId) || instanceId < 0 || instanceId >= ids.length) return null;
	return { kind: 'insert', insertId: ids[instanceId] };
}

export function targetToFocus(t: PickTarget): ToolingFocus {
	return t.kind === 'edge' ? { kind: 'edge', insertId: t.insertId, edgeId: t.edgeId } : { kind: 'insert', insertId: t.insertId };
}

export function sameTarget(a: PickTarget | null, b: PickTarget | null): boolean {
	if (a === b) return true;
	if (!a || !b || a.kind !== b.kind || a.insertId !== b.insertId) return false;
	return a.kind === 'edge' ? a.edgeId === (b as typeof a).edgeId : true;
}

// Inserts drawn see-through: depleted ones always, and every other insert while one is focused.
export function ghostInserts(model: ToolingModel, focus: ToolingFocus): Set<string> {
	const ghost = new Set<string>();
	for (const i of model.inserts) {
		if (i.depleted || (focus.kind !== 'box' && focus.insertId !== i.id)) ghost.add(i.id);
	}
	return ghost;
}

// The two instanced meshes (solid and see-through) are each filled with their own ids, in model order.
export function partitionInstances(ids: readonly string[], ghost: ReadonlySet<string>): { solid: string[]; ghost: string[] } {
	const out = { solid: [] as string[], ghost: [] as string[] };
	for (const id of ids) (ghost.has(id) ? out.ghost : out.solid).push(id);
	return out;
}
