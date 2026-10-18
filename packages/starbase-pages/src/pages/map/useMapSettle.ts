// Where the draft's cards end up, and what the canvas does about the places the draft keeps (redesign R6): new cards step off whatever
// they would lie on (settleFresh), Tidy lays the draft's own cards out again as one undoable step (tidy), and a place the draft changes
// without the pointer (Undo, Redo of a drag or of Tidy) is followed on the canvas (followStored). Kept apart from useMapCanvas, which
// owns the drawing and the layout; this takes what it needs of it through `SettleCtx`.

import { computed, watch, type Ref } from 'vue';
import type { GraphNode, useVueFlow } from '@vue-flow/core';
import { nodeOfSocket } from './model/sockets';
import { placeMerged, type Box } from './model/placeMerged';
import { settleNodes, tidyPositions } from './model/placeNode';
import type { MapNode } from './model/types';
import type { MergeHint } from './useMapExpand';
import type { createMapTween } from './useMapTween';
import type { CanvasEdit } from './useMapCanvas';
import type { useElkLayout } from './useElkLayout';
import type { useProcessMap } from './useProcessMap';

type ProcessMap = ReturnType<typeof useProcessMap>;
type Graph = NonNullable<ProcessMap['graph']['value']>;
type Points = Record<string, { x: number; y: number }>;
type Sizes = Record<string, { width: number; height: number }>;

/** What the settling needs of the canvas that calls it. */
export interface SettleCtx {
	vf: ReturnType<typeof useVueFlow>;
	map: ProcessMap;
	edit?: CanvasEdit;
	layout: ReturnType<typeof useElkLayout>['layout'];
	tween: ReturnType<typeof createMapTween>;
	/** Where the last layout put each node and how big it was then. */
	placed: Map<string, Box>;
	/** Cards the person dragged this visit: they stay where they were dropped. */
	dragged: Set<string>;
	/** Every card drawn at any time this visit, also the ones taken away since: a card that comes back (Undo) is not new. */
	seen: ReadonlySet<string>;
	atPlaced: (id: string) => { x: number; y: number } | undefined;
	measuredSize: (n: GraphNode) => { width: number; height: number } | null;
	allMeasured: () => boolean;
	busy: () => boolean;
	/** Runs a job the export must wait for (a layout in progress). */
	track: <T>(job: () => Promise<T>) => Promise<T>;
	whenSettled: (timeoutMs?: number) => Promise<boolean>;
	reorderSockets: (positions: Points) => Promise<void>;
	currentPositions: () => Points;
	layoutError: Ref<string>;
}

/** A place that differs from where a card is by less than this (flow units) is the same place. */
const SAME = 0.5;

const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function useMapSettle(ctx: SettleCtx) {
	const { vf, map, edit, tween, placed, dragged } = ctx;

	/**
	 * ＋ or − on a card: the whole map as ELK puts it, moved so that the card pressed keeps its place (no jump across the map), and
	 * every card that was dragged stays where it was dropped (spec D18). With no such card left (a − that took it away) the cards that
	 * were already on the map keep their typical offset instead.
	 */
	function fullAroundDragged(elk: Points, graph: Graph, sizes: Sizes, anchors: string[]): Points {
		const dir = map.dir.value;
		const here: Record<string, Box> = {};
		for (const n of vf.getNodes.value) {
			const was = placed.get(n.id);
			if (was && dragged.has(n.id)) here[n.id] = { x: n.position.x, y: n.position.y, width: was.width, height: was.height };
		}
		// Where a card is: where the last layout sent it (a card still moving is not there yet, and a layout that arrives mid-way must not
		// take that for its place: rapid ＋ and − would drift the map); a dragged card is where it is dropped.
		const placeOf = (id: string): { x: number; y: number } | undefined => (dragged.has(id) ? undefined : placed.get(id)) ?? vf.findNode(id)?.position;
		let shift = { x: 0, y: 0 };
		const anchor = anchors.find((id) => elk[id] && placeOf(id));
		if (anchor) {
			const now = placeOf(anchor)!;
			shift = { x: now.x - elk[anchor].x, y: now.y - elk[anchor].y };
		} else {
			const kept = vf.getNodes.value.filter((n) => placed.has(n.id) && !dragged.has(n.id) && elk[n.id]);
			shift = { x: median(kept.map((n) => placed.get(n.id)!.x - elk[n.id].x)), y: median(kept.map((n) => placed.get(n.id)!.y - elk[n.id].y)) };
		}
		const moved = Object.fromEntries(Object.entries(elk).map(([id, p]) => [id, { x: p.x + shift.x, y: p.y + shift.y }]));
		const wires = graph.wires.map((w) => ({ from: nodeOfSocket(w.from), to: nodeOfSocket(w.to) }));
		return placeMerged({ elk: moved, sizes, placed: here, edges: wires, dir, anchors, pinned: dragged, exact: true });
	}

	/**
	 * Where the cards go once the ones that would lie on another have stepped aside (model/placeNode.ts). `stored`: the cards the draft keeps a
	 * place for. In a first layout (a draft being opened) the cards with a stored place are where the person put them, whatever lies there;
	 * later, a card that is new and has a stored place (dropped from a menu or picker) is moved too, and the draft keeps its new place. A card
	 * that comes back (Undo, Redo) is not new: where the draft says it was put is where it goes, never a place the layout chose.
	 */
	function settleFresh(graph: Graph, positions: Points, sizes: Sizes, stored: ReadonlySet<string>, firstLayout: boolean, merges: MergeHint[] | null): Points {
		const boxes: Record<string, Box> = {};
		const nodeOf = new Map<string, GraphNode>();
		for (const n of vf.getNodes.value) {
			const size = sizes[n.id];
			if (!size) continue;
			const at = positions[n.id] ?? ctx.atPlaced(n.id) ?? n.position;
			boxes[n.id] = { x: at.x, y: at.y, ...size };
			nodeOf.set(n.id, n);
		}
		const movable = Object.keys(boxes)
			.filter((id) => !dragged.has(id) && !(stored.has(id) && ctx.seen.has(id)) && (firstLayout ? !stored.has(id) : !placed.has(id)))
			.sort((a, b) => boxes[a].x - boxes[b].x || boxes[a].y - boxes[b].y || (a < b ? -1 : 1));
		if (!movable.length) return positions;
		// The card each one is wired to and that is staying: the slot is beside it (the one it comes from first).
		const isMovable = new Set(movable);
		const anchors: Record<string, Box | undefined> = {};
		for (const id of movable) {
			const into = graph.wires.find((w) => nodeOfSocket(w.to) === id && boxes[nodeOfSocket(w.from)] && !isMovable.has(nodeOfSocket(w.from)));
			const out = graph.wires.find((w) => nodeOfSocket(w.from) === id && boxes[nodeOfSocket(w.to)] && !isMovable.has(nodeOfSocket(w.to)));
			const other = into ? nodeOfSocket(into.from) : out ? nodeOfSocket(out.to) : (merges ?? []).map((m) => m.anchor).find((a) => !!a && !!boxes[a] && !isMovable.has(a));
			anchors[id] = other ? boxes[other] : undefined;
		}
		const moved = settleNodes({ boxes, movable, anchors, dir: map.dir.value });
		const ids = Object.keys(moved);
		if (!ids.length) return positions;
		const next = { ...positions, ...moved };
		// A card the draft keeps a place for, moved off it: the draft keeps the new place (the step that added the card).
		if (!firstLayout && edit?.settled) {
			const kept = ids.filter((id) => stored.has(id) && nodeOf.get(id));
			if (kept.length) edit.settled(kept.map((id) => ({ node: nodeOf.get(id)!.data as MapNode, at: moved[id] })));
		}
		return next;
	}

	/**
	 * Tidy (R6): the draft's own cards go where ELK would put them, lined up with the cards that are not the draft's, which do not move;
	 * none ends on another. The draft keeps the places as ONE undoable step; the places the cards were at (when the draft had none for them)
	 * are kept in the step before, so Undo has somewhere to take them back to.
	 */
	async function tidy(): Promise<void> {
		const graph = map.graph.value;
		if (!edit?.owned || !graph || !ctx.allMeasured() || ctx.busy()) return;
		const sizes: Sizes = {};
		for (const n of vf.getNodes.value) {
			const s = ctx.measuredSize(n);
			if (s) sizes[n.id] = s;
		}
		const nodes = vf.getNodes.value.filter((n) => sizes[n.id]);
		await ctx.track(async () => {
			try {
				const elk = await ctx.layout(graph, new Set(nodes.map((n) => n.id)), sizes, map.dir.value);
				const owned: Points = {};
				const fixed: Record<string, Box> = {};
				for (const n of nodes) {
					if (edit.owned!(n.data as MapNode)) owned[n.id] = { x: n.position.x, y: n.position.y };
					else fixed[n.id] = { x: n.position.x, y: n.position.y, ...sizes[n.id] };
				}
				const target = tidyPositions({ elk, sizes, fixed, owned, dir: map.dir.value });
				const ids = Object.keys(target);
				if (!ids.length) return;
				// Where they are now, for the cards the draft keeps no place for (Undo goes back to these).
				const pins = ids.filter((id) => !edit.positionOf(vf.findNode(id)!.data as MapNode));
				if (pins.length) edit.settled?.(pins.map((id) => ({ node: vf.findNode(id)!.data as MapNode, at: owned[id] })));
				for (const id of ids) {
					placed.set(id, { ...target[id], ...sizes[id] });
					dragged.delete(id);
				}
				await tween.start({ target, fresh: new Set(), origin: null, instant: false });
				await ctx.reorderSockets(ctx.currentPositions());
				edit.relaid(ids.map((id) => ({ node: vf.findNode(id)!.data as MapNode, at: target[id] })));
			} catch (e) {
				tween.stop();
				ctx.layoutError.value = `Could not tidy the map: ${e instanceof Error ? e.message : String(e)}`;
			}
		});
	}

	/** Something on the canvas is the draft's own: Tidy has something to lay out. */
	const canTidy = computed(() => !!edit?.owned && map.nodes.value.some((n) => edit.owned!(n)));

	// ---- the places the draft keeps change without the pointer (Undo, Redo) --------------------------------------
	/** The places the draft keeps for the cards drawn, by node id. */
	const storedPlaces = computed(() => {
		const out: Points = {};
		if (edit) for (const n of map.nodes.value) {
			const at = edit.positionOf(n);
			if (at) out[n.id] = { x: at.x, y: at.y };
		}
		return out;
	});
	/** Cards the pointer holds right now: a place the draft has for them is the old one until they are dropped. */
	const dragging = new Set<string>();
	let following = 0;
	/**
	 * Undo and Redo change the places the draft keeps (a drag, Tidy) and the cards must go there: the canvas otherwise only reads them when
	 * it lays out, and no layout follows a change of places alone. Waits for a layout or a move in progress (it ends at the places the draft
	 * has by then, and writes the ones it chose itself), then glides each card that is not at its place to it. A card the layout has not
	 * placed yet (a new one, or one that comes back) is the layout's: it reads the draft's place itself.
	 */
	function followStored(): void {
		if (!edit) return;
		watch(() => JSON.stringify(storedPlaces.value), async () => {
			const mine = ++following;
			await ctx.whenSettled(3000);
			if (mine !== following) return;
			const target: Points = {};
			for (const n of vf.getNodes.value) {
				const at = storedPlaces.value[n.id];
				if (at && placed.has(n.id) && !dragging.has(n.id) && (Math.abs(n.position.x - at.x) > SAME || Math.abs(n.position.y - at.y) > SAME)) target[n.id] = at;
			}
			const ids = Object.keys(target);
			if (!ids.length) return;
			for (const id of ids) {
				const size = ctx.measuredSize(vf.findNode(id)!);
				placed.set(id, { ...target[id], ...(size ?? { width: 0, height: 0 }) });
			}
			await ctx.track(async () => {
				await tween.start({ target, fresh: new Set(), origin: null, instant: false });
				await ctx.reorderSockets(ctx.currentPositions());
			});
		});
	}
	/** Where each card being dragged was when the pointer took it: Undo of a first drag goes back there. */
	const pickedUpAt = new Map<string, { x: number; y: number }>();
	/**
	 * Grabbing a card takes it out of the move (it follows the pointer, not the layout); letting go pins it (spec D18), tells the draft
	 * where it went (and where it came from) and the sockets of the cards it is wired to may now be better the other way round.
	 */
	function watchDrags(): void {
		vf.onNodeDragStart((e) => {
			tween.cancel(e.nodes.map((n) => n.id));
			for (const n of e.nodes) {
				dragging.add(n.id);
				const at = vf.findNode(n.id)?.position;
				if (at) pickedUpAt.set(n.id, { x: at.x, y: at.y });
			}
		});
		vf.onNodeDragStop((e) => {
			for (const n of e.nodes) {
				dragged.add(n.id);
				dragging.delete(n.id);
			}
			void ctx.reorderSockets(ctx.currentPositions());
		});
		vf.onNodeDragStop(({ node }) => {
			edit?.moved(node.data as MapNode, { x: node.position.x, y: node.position.y }, pickedUpAt.get(node.id));
			pickedUpAt.delete(node.id);
		});
	}

	return { settleFresh, fullAroundDragged, tidy, canTidy, followStored, watchDrags, dragging };
}
