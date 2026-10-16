// The 2D tray plan: the tool box seen from above, as one SVG that mirrors the 3D tray. Pure and three-free (this file is in
// the entry chunk): the tray, its pockets and the etched text come from the same layout the 3D view is built from
// (scene/trayLayout.ts, scene/etchLayout.ts), and each pocket holds the insert's real outline with one dot per edge (the
// letters are in the insert view, the hover label and the aria labels). Millimetres. SVG y runs down, like the 3D tray's z: the far end of the tray is at the top.

import type { ToolingEdge, ToolingInsert, ToolingModel } from '@d1/ui';
import { etchLabels } from './scene/etchLayout';
import { trayLayout, type TrayLayout } from './scene/trayLayout';
import { freshCaption, STATE_LABEL } from './slots2d';

const f = (n: number): number => Math.round(n * 100) / 100;

// The 3D layout with each pocket PLAN_ROOM_MM roomier on every side: the same columns, rows, margins and text places, a little
// more tray between the centres.
export function withPocketRoom(l: TrayLayout, room = PLAN_ROOM_MM): TrayLayout {
	const pitch = l.pitch + 2 * room;
	return {
		...l, pitch, pocketW: l.pocketW + 2 * room, pocketD: l.pocketD + 2 * room,
		width: l.width + (l.single ? 1 : l.columns) * 2 * room, depth: l.depth + (l.single ? 1 : l.rows) * 2 * room,
		centre: l.single ? l.centre : (column, row) => ({ x: (column - (l.columns - 1) / 2) * pitch, z: (row - (l.rows - 1) / 2) * pitch }),
	};
}

// How much of each pocket is drawn: the edge dots, or just the outline (a very large box).
export type PlanDetail = 'dots' | 'none';
export const DOTS_UP_TO = 60;
export function planDetail(slots: number): PlanDetail {
	return slots <= DOTS_UP_TO ? 'dots' : 'none';
}

export interface PlanDot {
	key: string;
	edgeId: string;
	letter: string | null;
	x: number; y: number; r: number; // pocket-local (the pocket's centre is 0, 0)
	used: boolean;
	face: 'top' | 'bottom' | null; // null: the edge has no place on the drawing (a hollow dot, in a row at the pocket's foot)
	hollow: boolean;
	next: boolean;
	name: string;
}

export interface PlanPocket {
	key: string;
	slot: number; // index into layout.slots
	label: string;
	x: number; y: number; w: number; h: number; // the pocket's centre and size
	insert: ToolingInsert | null; // null: an empty slot
	state: ToolingInsert['state'] | null;
	next: boolean;
	dots: PlanDot[];
	name: string; // the accessible name
}

export interface PlanText {
	key: string;
	kind: 'number' | 'title';
	text: string;
	x: number; y: number; // the centre
	size: number; // font size
	length: number | null; // a title is fitted to this width
}

export interface TrayPlan {
	layout: TrayLayout;
	detail: PlanDetail;
	viewBox: string;
	tray: { x: number; y: number; w: number; h: number; r: number };
	pocketRadius: number;
	outline: string; // the insert's outline, in pocket-local coordinates, shared by every pocket
	hole: number | null; // the hole's radius
	pockets: PlanPocket[];
	texts: PlanText[];
}

const PAD_MM = 2.5;
// The 3D pockets leave about 1.2 mm round the insert; the plan gives each a little more (this much on every side), so the dots
// at the corners sit beside the tip rather than on it and the insert still reads as its shape. The tray grows to match.
export const PLAN_ROOM_MM = 2;
const DOT_R_MAX = 2.5; // about 1.6 times the first version's dots
const DOT_R_MIN = 0.8;
const DOT_SHARE = 0.2; // of the insert's inscribed circle
const UNDER_SCALE = 0.8; // an underside dot is this much of a top-face dot
const DOT_GAP = 1.3; // between the two dots of a corner: the corner's tip shows in the gap, so the insert still reads as its shape
const POCKET_CLEAR = 0.3; // a dot stays this far inside the pocket's wall
const UNPLACED_R = 0.9;

interface Spot { x: number; y: number; r: number }

// The dots of one insert, in pocket-local coordinates, with no letters: at each cutting corner the top-face edge's dot and,
// on a double-sided insert, the underside edge's dot SIDE BY SIDE across the corner (the top-face one filled and larger,
// the underside one smaller with a ring), centred on the corner's axis at its tip. One dot per corner for a single-sided
// insert. They are as big as fit: never overlapping, and inside the pocket so they stay clear of the next one. An edge with no
// place on the drawing is a hollow dot, in a row at the pocket's foot.
export function insertDots(model: ToolingModel, insert: ToolingInsert, nextEdgeId: string | null, pocket: { w: number; h: number }): PlanDot[] {
	const { geometry: g, outline } = model;
	const byCorner = new Map<number, { top?: ToolingEdge; bottom?: ToolingEdge }>();
	const unplaced: ToolingEdge[] = [];
	for (const e of insert.edges) {
		if (!e.placement || !outline.corners[e.placement.corner]) { unplaced.push(e); continue; }
		const slot = byCorner.get(e.placement.corner) ?? {};
		slot[e.placement.face] = e;
		byCorner.set(e.placement.corner, slot);
	}

	// The spots of every dot at one size: the pair (or the single dot) of a corner sits on its bisector, as far out toward the
	// tip as the pocket allows (never more than half a radius past it, so the tip shows); a pair is spread across the bisector,
	// the top-face dot on the left. Null when a corner has no room for its dots at this size.
	const inside = (p: Spot): boolean => Math.abs(p.x) + p.r <= pocket.w / 2 - POCKET_CLEAR && Math.abs(p.y) + p.r <= pocket.h / 2 - POCKET_CLEAR;
	const layout = (rt: number): Map<string, Spot> | null => {
		const ru = rt * UNDER_SCALE;
		const out = new Map<string, Spot>();
		for (const [corner, pair] of byCorner) {
			const c = outline.corners[corner];
			const a = (c.bisectorDeg * Math.PI) / 180;
			const tip = Math.hypot(c.x, c.y) + (g.shape === 'R' ? 0 : g.noseRadiusMm);
			const ux = Math.cos(a), uy = -Math.sin(a); // the bisector, SVG's y down
			let vx = -uy, vy = ux; // across it
			if (vx > 1e-6 || (Math.abs(vx) <= 1e-6 && vy > 0)) { vx = -vx; vy = -vy; } // toward the left of the page
			const both = pair.top && pair.bottom;
			const sep = rt + ru + DOT_GAP; // between the two centres
			const at = (d: number): Array<[string, Spot]> => (['top', 'bottom'] as const).flatMap((side): Array<[string, Spot]> => {
				const e = pair[side];
				if (!e) return [];
				const o = !both ? 0 : side === 'top' ? sep / 2 : -sep / 2;
				return [[e.id, { x: f(ux * d + vx * o), y: f(uy * d + vy * o), r: f(side === 'top' ? rt : ru) }]];
			});
			let placed: Array<[string, Spot]> | null = null;
			for (let d = tip + rt * 0.5; d >= tip - 2 * rt; d -= 0.05) {
				const spots = at(d);
				if (spots.every(([, p]) => inside(p))) { placed = spots; break; }
			}
			if (!placed) return null;
			for (const [id, p] of placed) out.set(id, p);
		}
		return out;
	};
	const apart = (spots: Map<string, Spot>): boolean => {
		const all = [...spots.values()];
		return all.every((p, i) => all.every((q, j) => j <= i || Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r + 0.05));
	};
	let rt = Math.min(DOT_R_MAX, g.icMm * DOT_SHARE);
	let spots = layout(rt);
	while (rt > DOT_R_MIN && (!spots || !apart(spots))) { rt -= 0.05; spots = layout(rt); }
	if (!spots) spots = new Map();

	const dots: PlanDot[] = [];
	for (const e of insert.edges) {
		const p = spots.get(e.id);
		if (!p || !e.placement) continue;
		dots.push({
			key: e.id, edgeId: e.id, letter: e.letter, x: p.x, y: p.y, r: p.r, used: e.used, face: e.placement.face,
			hollow: false, next: e.id === nextEdgeId, name: dotName(e),
		});
	}
	const step = UNPLACED_R * 2.6;
	unplaced.forEach((e, k) => {
		dots.push({
			key: e.id, edgeId: e.id, letter: null, x: f((k - (unplaced.length - 1) / 2) * step), y: f(pocket.h / 2 - 1.2), r: UNPLACED_R,
			used: e.used, face: null, hollow: true, next: e.id === nextEdgeId, name: dotName(e),
		});
	});
	return dots;
}

const dotName = (e: ToolingEdge): string =>
	`Edge ${e.letter ?? (e.identifier || '?')}, ${e.used ? 'used' : 'fresh'}${e.placement?.face === 'bottom' ? ', underside' : ''}${e.placement ? '' : ', position unknown'}`;

export function buildTrayPlan(model: ToolingModel, nextFresh: { insertId: string; edgeId: string } | null): TrayPlan {
	const layout = withPocketRoom(trayLayout(model));
	const detail = planDetail(layout.slots.length);
	const insertOf = new Map(model.inserts.map((i) => [i.id, i]));

	const outline = model.outline.points.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${f(x)} ${f(-y)}`).join(' ') + ' Z';
	const hole = model.geometry.holeDiameterMm ? f(Math.min(model.geometry.holeDiameterMm / 2, (model.geometry.icMm / 2) * 0.6)) : null;

	const pockets = layout.slots.map((slot, k): PlanPocket => {
		const c = layout.centre(slot.column, slot.row);
		const insert = slot.insertId ? insertOf.get(slot.insertId) ?? null : null;
		const dots = insert && detail !== 'none' ? insertDots(model, insert, nextFresh?.insertId === insert.id ? nextFresh.edgeId : null, { w: layout.pocketW, h: layout.pocketD }) : [];
		return {
			key: `s${slot.column}:${slot.row}`, slot: k, label: slot.label, x: f(c.x), y: f(c.z), w: f(layout.pocketW), h: f(layout.pocketD),
			insert, state: insert ? insert.state : null, next: insert !== null && nextFresh?.insertId === insert.id, dots,
			name: insert ? `Insert ${slot.label}, ${STATE_LABEL[insert.state]}, ${freshCaption(insert)}` : `Slot ${slot.label}, empty`,
		};
	});

	const titles = { top: model.boxCode.trim() || null, bottom: model.typeCode };
	const texts = etchLabels(layout, titles).map((e, k): PlanText => ({
		key: `t${k}`, kind: e.slot >= 0 ? 'number' : 'title', text: e.text, x: f(e.x), y: f(e.z), size: f(e.h),
		length: e.slot >= 0 ? null : f(e.w),
	}));

	const w = layout.width;
	const h = layout.depth;
	return {
		layout, detail,
		viewBox: `${f(-w / 2 - PAD_MM)} ${f(-h / 2 - PAD_MM)} ${f(w + 2 * PAD_MM)} ${f(h + 2 * PAD_MM)}`,
		tray: { x: f(-w / 2), y: f(-h / 2), w: f(w), h: f(h), r: f(Math.min(layout.pitch * 0.18, 5)) },
		pocketRadius: 1.6, outline, hole, pockets, texts,
	};
}
