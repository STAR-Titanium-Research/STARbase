// The Process map's Vue Flow canvas: turns the shown nodes into Vue Flow nodes and edges, lays them out
// with ELK once Vue Flow has measured them, animates them to their places, and keeps the project frame
// (spec D13) round them. Everything about *what* is shown lives in useProcessMap; this is the drawing.
//
// Layout runs only on measured sizes: Vue Flow reports 0x0 until a node is mounted and measured, so a
// layout waits for `onNodesInitialized` (and elkInput treats a non-positive size as unmeasured).

import { computed, getCurrentScope, markRaw, nextTick, onScopeDispose, ref, watch } from 'vue';
import { useVueFlow, type Edge, type GraphNode, type Node, type NodeTypesObject, type EdgeTypesObject, type Styles } from '@vue-flow/core';
import { nodeOfSocket } from './model/sockets';
import { fanNodeIds } from './model/fans';
import { placeMerged, type Box } from './model/placeMerged';
import { reslot } from './model/reslot';
import { shownNodes } from './model/reach';
import { structureKey } from './model/structureKey';
import { socketOrder } from './model/socketOrder';
import type { MapNode } from './model/types';
import ContainerNode from './nodes/ContainerNode.vue';
import JunctionNode from './nodes/JunctionNode.vue';
import RecordNode from './nodes/RecordNode.vue';
import WireEdge from './nodes/WireEdge.vue';
import { cardLabel } from './nodes/a11y';
import { KINDS } from './nodes/kinds';
import { wireTooltip } from './nodes/wireTooltip';
import MoreNode from './nodes/MoreNode.vue';
import type { MergeHint } from './useMapExpand';
import type { useProcessMap } from './useProcessMap';
import { useElkLayout } from './useElkLayout';
import { createMapTween, type TweenFrame } from './useMapTween';
import { useMapSettle } from './useMapSettle';

type ProcessMap = ReturnType<typeof useProcessMap>;

const nodeTypes = { record: markRaw(RecordNode), container: markRaw(ContainerNode), junction: markRaw(JunctionNode), more: markRaw(MoreNode) } as unknown as NodeTypesObject;
const edgeTypes = { wire: markRaw(WireEdge) } as unknown as EdgeTypesObject;

/** The furthest the map zooms out (the page's Vue Flow `min-zoom`). */
export const MIN_ZOOM = 0.1;

/**
 * One screen pixel in flow units at `zoom`: what a dashed outline's width is multiplied by so it is the same on screen
 * at every zoom down to MIN_ZOOM (a zoom below it, or a bad value, counts as MIN_ZOOM).
 */
export const screenPixel = (zoom: number): number => 1 / (Number.isFinite(zoom) ? Math.max(zoom, MIN_ZOOM) : MIN_ZOOM);

/** Room round the nodes for the project frame and its label. */
const FRAME_PAD = 28;
const FRAME_LABEL = 30;
const FIT_PADDING = 0.12;
/** Nodes of a used-in fan the first view frames: its record and the first few items. */
const FAN_FIT = 9;

const reducedMotion = (): boolean => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** The `--k-*` colour of a node, for the minimap. */
export function miniMapColor(node: { data?: MapNode }): string {
  const d = node.data;
  const kind = d?.type === 'record' ? d.kind : d?.type === 'container' ? d.kind : 'junction';
  return `var(${KINDS[kind].color})`;
}

/** What edit mode asks of the canvas (spec §7.2): where the draft says its cards are, and being told when one is moved. */
export interface CanvasEdit {
  /** The draft is on the map: a change that only alters what cards say is patched in place, with no new layout unless a card changed size. */
  active?(): boolean;
  /** Where the draft keeps a card (flow coordinates), when the person placed it; layout leaves such cards there. */
  positionOf(node: MapNode): { x: number; y: number } | undefined;
  /** A card was dragged and dropped (`from`: where it was when taken, so Undo has somewhere to bring it back to). */
  moved(node: MapNode, at: { x: number; y: number }, from?: { x: number; y: number }): void;
  /** Re-layout put every card where ELK wants it: the draft keeps those places (one change for all of them). */
  relaid(cards: { node: MapNode; at: { x: number; y: number } }[]): void;
  /** The card is the draft's own (a new item, or a sample the draft picked from the index): Tidy moves it, and nothing else. */
  owned?(node: MapNode): boolean;
  /**
   * Cards the draft had a place for that were moved to clear another card (R6): the draft keeps the new places, folded into the step that
   * added them (so undoing the add takes the place away with it).
   */
  settled?(cards: { node: MapNode; at: { x: number; y: number } }[]): void;
}

export function useMapCanvas(map: ProcessMap, edit?: CanvasEdit) {
  const vf = useVueFlow();
  const { layout } = useElkLayout();

  // The move to the laid-out places (useMapTween): Vue Flow's own node positions, frame by frame, so the wires follow the cards.
  const tween = createMapTween({
    positionOf: (id) => {
      const p = vf.findNode(id)?.position;
      return p && { x: p.x, y: p.y };
    },
    apply: (frames: TweenFrame[]) => {
      vf.applyNodeChanges(frames.map((f) => ({ id: f.id, type: 'position' as const, from: f.from, position: f.position })));
      for (const f of frames) if (f.opacity !== undefined) setOpacity(f.id, f.opacity);
    },
    raf: typeof requestAnimationFrame === 'undefined' ? undefined : (cb) => requestAnimationFrame(cb),
    cancelRaf: (h) => cancelAnimationFrame(h as number),
    reducedMotion,
  });
  /** A card that is fading in is a little see-through (the node wrapper's own style); at 1 the style is cleared. */
  function setOpacity(id: string, opacity: number): void {
    const node = vf.findNode(id);
    if (!node) return;
    const style: Record<string, string | number | undefined> = { ...(typeof node.style === 'object' && node.style ? (node.style as Record<string, string>) : {}) };
    if (opacity < 1) style.opacity = opacity;
    else delete style.opacity;
    node.style = style as Styles;
  }

  /** False until the first layout of a freshly loaded family has run: the canvas stays invisible so nodes do not flash at 0,0. */
  const laidOut = ref(false);
  const layoutError = ref('');
  let needsFit = true;
  let pending = false;
  /** Layouts (and the move to their places) in progress: the export waits for none (whenSettled). */
  let running = 0;
  const busy = () => pending || running > 0 || tween.active();
  const settledWaiters = new Set<() => void>();
  const notifySettled = () => [...settledWaiters].forEach((check) => check());
  /** The pending layout is an expand (new cards go beside what is placed), not a full layout; a full one wins when both are asked for. */
  let pendingMerges: MergeHint[] = [];
  let pendingFull = true;
  let token = 0;
  /** The next layout is Re-layout: cards the draft placed go where ELK puts them too, and the draft keeps those places. */
  let free = false;
  /** Where the last layout put each node and how big it was then: for nodes that are rebuilt (hidden chips, folds) but were not dragged, and to tell cards that are new, or that grew. */
  const placed = new Map<string, Box>();
  /** Cards the person dragged this visit: they stay where they were dropped, whatever else changes, until Re-layout, a new direction or a new focus. */
  const dragged = new Set<string>();
  /** Every card drawn this visit, also the ones taken away since: a card that comes back (Undo) is not new, and keeps the place the draft has for it. */
  const seen = new Set<string>();
  /** The expand being drawn: new cards start at the card that was expanded instead of the origin. */
  let merging: MergeHint | null = null;

  // ---- elements ---------------------------------------------------------------------------------
  const atPlaced = (id: string): { x: number; y: number } | undefined => {
    const b = placed.get(id);
    return b && { x: b.x, y: b.y };
  };
  const startOfMerge = (): { x: number; y: number } | null => {
    const id = merging?.anchor;
    const at = id ? (vf.findNode(id)?.position ?? placed.get(id)) : null;
    return at ? { x: at.x, y: at.y } : null;
  };
  /** Record and junction cards whose sockets were put in the order of their wires (socketOrder): kept so a rebuild does not undo it. */
  const ordered = new Map<string, MapNode>();
  const socketIds = (n: MapNode): string => (n.type === 'record' ? [...n.ins, '|', ...n.outs] : n.type === 'junction' ? [n.in, '|', ...n.outs.map((o) => o.socket)] : []).sort().join(',');
  /** The card as it is drawn: the model's, with its sockets in the order last worked out (if the card still has the same sockets). */
  const drawn = (n: MapNode): MapNode => {
    const o = ordered.get(n.id);
    if (!o || socketIds(o) !== socketIds(n)) return n;
    if (n.type === 'record' && o.type === 'record') return { ...n, ins: o.ins, outs: o.outs };
    if (n.type === 'junction' && o.type === 'junction') {
      const row = new Map(n.outs.map((x) => [x.socket, x]));
      return { ...n, outs: o.outs.map((x) => row.get(x.socket)!) };
    }
    return n;
  };
  function elements(): { nodes: Node[]; edges: Edge[] } {
    const list = map.nodes.value;
    const byId = new Map(list.map((n) => [n.id, n]));
    const nodes: Node[] = list.map((n) => ({
      id: n.id,
      type: n.type,
      position: vf.findNode(n.id)?.position ?? atPlaced(n.id) ?? startOfMerge() ?? { x: 0, y: 0 },
      data: drawn(n),
      // A rebuild while a card is still fading in keeps it as see-through as it was.
      ...(tween.opacityOf(n.id) !== undefined ? { style: { opacity: tween.opacityOf(n.id) } } : {}),
      draggable: true,
      selectable: false,
      // The card's wrapper is its tab stop (spec D23) and is named for screen readers; the "+N more" stub is its own button.
      focusable: n.type !== 'more',
      ariaLabel: cardLabel(n) ?? undefined,
    }));
    const edges: Edge[] = (map.graph.value?.wires ?? [])
      .filter((w) => byId.has(nodeOfSocket(w.from)) && byId.has(nodeOfSocket(w.to)))
      .map((w) => ({
        id: w.id,
        type: 'wire',
        source: nodeOfSocket(w.from),
        target: nodeOfSocket(w.to),
        sourceHandle: w.from,
        targetHandle: w.to,
        selectable: false,
        focusable: false,
        data: { wire: w, tooltip: wireTooltip(w, byId) },
      }));
    return { nodes, edges };
  }

  /**
   * While a card or slot is hovered the nodes and wires that are not next to it dim, and its own wires
   * are highlighted (spec §6.3); hovering a wire or a socket only highlights wires. Classes on Vue Flow's
   * own wrappers (mapTokens.css), written only where they change.
   */
  function applyFocus(): void {
    const f = map.focusOfHover.value;
    for (const n of vf.getNodes.value) {
      const cls = f?.dim && !f.nodes.has(n.id) ? 'dim' : undefined;
      if (n.class !== cls) n.class = cls;
    }
    for (const e of vf.getEdges.value) {
      const cls = f?.wires.has(e.id) ? 'hi' : f?.dim ? 'dim' : undefined;
      if (e.class !== cls) e.class = cls;
    }
  }

  /**
   * Edit mode, a change that left the cards, sockets and wires as they were (a value typed into the form): the cards' data is replaced
   * where it is. Vue Flow keeps its nodes, so nothing is measured again and ELK does not run, unless a card changed size (settleSizes).
   */
  function patchInPlace(): void {
    const { nodes, edges } = elements();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const n of vf.getNodes.value) {
      const next = byId.get(n.id);
      if (!next) continue;
      n.data = next.data;
      n.ariaLabel = next.ariaLabel;
    }
    const wires = new Map(edges.map((e) => [e.id, e]));
    for (const e of vf.getEdges.value) {
      const next = wires.get(e.id);
      if (next) e.data = next.data;
    }
  }
  /** Typing makes a burst of patches: the sizes are looked at once, when it pauses. */
  const SIZE_CHECK_MS = 150;
  let sizeTimer: ReturnType<typeof setTimeout> | null = null;
  function settleSizes(): void {
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => void checkSizes(), SIZE_CHECK_MS);
  }
  async function checkSizes(): Promise<void> {
    sizeTimer = null;
    if (busy()) return settleSizes(); // a layout is on its way: look again when it is done
    const ids = vf.getNodes.value.map((n) => n.id);
    if (!ids.length) return;
    await nextTick();
    vf.updateNodeInternals(ids);
    await nextTick();
    const changed = vf.getNodes.value.some((n) => {
      const size = measuredSize(n);
      const was = placed.get(n.id);
      return !!size && !!was && (Math.abs(size.width - was.width) > 1 || Math.abs(size.height - was.height) > 1);
    });
    if (changed) await reflow();
  }
  if (getCurrentScope()) onScopeDispose(() => sizeTimer && clearTimeout(sizeTimer));

  function rebuild(): void {
    const { nodes, edges } = elements();
    vf.setNodes(nodes);
    vf.setEdges(edges);
    applyFocus();
  }

  // ---- layout -----------------------------------------------------------------------------------
  const measuredSize = (n: GraphNode) => (n.dimensions.width > 0 && n.dimensions.height > 0 ? { width: n.dimensions.width, height: n.dimensions.height } : null);
  const allMeasured = () => vf.getNodes.value.length > 0 && vf.getNodes.value.every((n) => measuredSize(n));

  /** Where every drawn card is now. */
  const currentPositions = (): Record<string, { x: number; y: number }> => Object.fromEntries(vf.getNodes.value.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
  /**
   * Puts the sockets of every record and junction card in the order of their wires (model/socketOrder.ts), for cards at `positions`.
   * A card whose order changed is told to Vue Flow once (updateNodeInternals), after the DOM has the new order, so its wires meet the
   * sockets where they are now.
   */
  async function reorderSockets(positions: Record<string, { x: number; y: number }>): Promise<void> {
    const graph = map.graph.value;
    if (!graph) return;
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const n of vf.getNodes.value) {
      const s = measuredSize(n);
      if (s) sizes[n.id] = s;
    }
    const byId = new Map(map.nodes.value.map((n) => [n.id, n]));
    const changed: string[] = [];
    for (const n of vf.getNodes.value) {
      const data = n.data as MapNode | undefined;
      if (!data) continue;
      const next = socketOrder(data, graph.wires, positions, sizes, map.dir.value, byId);
      if (next === data) continue;
      ordered.set(n.id, next);
      n.data = next;
      changed.push(n.id);
    }
    if (!changed.length) return;
    await nextTick();
    vf.updateNodeInternals(changed);
  }


  /** Runs a job the export must wait for: a layout or a move in progress (`busy`). */
  async function track<T>(job: () => Promise<T>): Promise<T> {
    running++;
    try {
      return await job();
    } finally {
      running--;
      notifySettled();
    }
  }
  const runLayout = (): Promise<void> => track(layoutOnce);

  const settle = useMapSettle({ vf, map, edit, layout, tween, placed, dragged, seen, atPlaced, measuredSize, allMeasured, busy, track, whenSettled, reorderSockets, currentPositions, layoutError });
  settle.followStored();

  async function layoutOnce(): Promise<void> {
    const mine = ++token;
    pending = false;
    // A change of what is shown lays out only what is new (spec §6.7); a first layout, Re-layout and a new direction lay out everything.
    const merges = pendingFull || !placed.size ? null : pendingMerges;
    pendingFull = true;
    pendingMerges = [];
    const graph = map.graph.value;
    if (!graph || !vf.getNodes.value.length) return;
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const n of vf.getNodes.value) {
      const s = measuredSize(n);
      if (s) sizes[n.id] = s;
    }
    try {
      const elk = await layout(graph, new Set(vf.getNodes.value.map((n) => n.id)), sizes, map.dir.value);
      if (mine !== token) return; // a newer layout (or a new family) supersedes this one
      layoutError.value = '';
      let positions = elk;
      // Re-layout (free): the cards the draft placed go where ELK puts them too, and the draft keeps those places.
      const relaying = free;
      free = false;
      const anchors = (merges ?? []).flatMap((m) => (m.anchor ? [m.anchor] : []));
      if (merges?.some((m) => m.full)) {
        // ＋ and −: the whole map is laid out again, round the cards that were dragged.
        positions = settle.fullAroundDragged(elk, graph, sizes, anchors);
      } else if (merges) {
        // Cards already placed stay where they are (a dragged one stays where it was dropped): only new cards, and cards a grown one pushed, move.
        const here: Record<string, Box> = {};
        for (const n of vf.getNodes.value) {
          const was = placed.get(n.id);
          if (was && (dragged.has(n.id) || !merges.some((m) => m.replace?.includes(n.id)))) here[n.id] = dragged.has(n.id) ? { x: n.position.x, y: n.position.y, width: was.width, height: was.height } : { ...was };
        }
        const wires = graph.wires.map((w) => ({ from: nodeOfSocket(w.from), to: nodeOfSocket(w.to) }));
        positions = placeMerged({ elk, sizes, placed: here, edges: wires, dir: map.dir.value, anchors, pinned: dragged });
      }
      // Cards the person placed (dragged, or dropped from the Add menu) stay where the draft says, whatever ELK would do.
      const stored = new Set<string>();
      if (edit && !relaying) {
        positions = { ...positions };
        const own = stored;
        const shifts: { id: string; dx: number; dy: number }[] = [];
        for (const n of vf.getNodes.value) {
          const at = edit.positionOf(n.data as MapNode);
          if (!at) continue;
          own.add(n.id);
          const was = positions[n.id] ?? n.position;
          shifts.push({ id: n.id, dx: at.x - was.x, dy: at.y - was.y });
          positions[n.id] = at;
        }
        // A material, stock lot or powder batch only ever sits beside what it feeds: it goes along with that card.
        const sources = new Set(graph.nodes.filter((m) => m.type === 'record' && ['material', 'stock_lot', 'powder_batch'].includes(m.kind)).map((m) => m.id));
        for (const w of graph.wires) {
          const src = nodeOfSocket(w.from);
          const shift = shifts.find((x) => x.id === nodeOfSocket(w.to));
          if (shift && sources.has(src) && !own.has(src) && positions[src]) positions[src] = { x: positions[src].x + shift.dx, y: positions[src].y + shift.dy };
        }
      }
      // R6: nothing new lies on another card. A card that has no place of the draft's and is new here (or, in a first layout, that has no place
      // of the draft's at all) steps to the nearest free slot beside what it is wired to if it would lie on another; the others stay exactly where
      // they are. A place the draft had kept for a new card that is moved off is kept as the new one.
      if (edit && !relaying) positions = settle.settleFresh(graph, positions, sizes, stored, !placed.size, merges);
      if (merges) {
        // A container that folded or unfolded: the cards on its sockets deal out the places they have, in the sockets' order (they glide there).
        for (const m of merges) {
          const container = m.reslot ? graph.nodes.find((n) => n.id === m.reslot) : undefined;
          if (container?.type !== 'container') continue;
          const boxes: Record<string, Box> = {};
          for (const n of vf.getNodes.value) {
            const at = positions[n.id] ?? n.position;
            if (sizes[n.id]) boxes[n.id] = { x: at.x, y: at.y, ...sizes[n.id] };
          }
          positions = { ...positions, ...reslot({ container, wires: graph.wires, boxes, dragged, dir: map.dir.value, containers: graph.nodes.filter((n): n is typeof container => n.type === 'container') }) };
        }
      }
      // New cards (not placed before) start at the card that was expanded and fade in; the first layout of a family is not shown (the canvas is hidden), so it is just placed.
      // A card still on its way to the place the last layout gave it keeps going there (the new tween replaces the old one: it must still name it).
      if (merges) {
        for (const n of vf.getNodes.value) {
          const pending = placed.get(n.id);
          if (!positions[n.id] && !dragged.has(n.id) && pending && (pending.x !== n.position.x || pending.y !== n.position.y)) positions = { ...positions, [n.id]: { x: pending.x, y: pending.y } };
        }
      }
      const firstLayout = !placed.size;
      const fresh = new Set(firstLayout ? [] : Object.keys(positions).filter((id) => !placed.has(id)));
      const from = anchors.map((id) => vf.findNode(id)?.position ?? placed.get(id)).find((p) => !!p);
      for (const n of vf.getNodes.value) {
        const at = positions[n.id] ?? (merges ? n.position : undefined);
        const size = sizes[n.id];
        if (at && size) placed.set(n.id, { x: at.x, y: at.y, ...size });
        seen.add(n.id);
      }
      // The sockets are put in the order of their wires for the places the cards are going to, before they move: the wires never cross on the way.
      await reorderSockets({ ...currentPositions(), ...positions });
      if (mine !== token) return;
      await tween.start({ target: positions, fresh, origin: from ? { x: from.x, y: from.y } : null, instant: firstLayout });
      if (mine !== token) return;
      await reorderSockets(currentPositions()); // (a card that was dragged mid-way, or a place that was cleared, can change the order again)
      if (mine !== token) return;
      if (edit && relaying) edit.relaid(vf.getNodes.value.map((n) => ({ node: n.data as MapNode, at: { x: positions[n.id]?.x ?? n.position.x, y: positions[n.id]?.y ?? n.position.y } })));
      laidOut.value = true;
      if (needsFit) {
        needsFit = false;
        await fitFocus(false); // the first view of a family: no glide from the default viewport
      }
    } catch (e) {
      if (mine !== token) return;
      tween.stop(); // nothing is left half-visible
      layoutError.value = `Could not lay out the map: ${e instanceof Error ? e.message : String(e)}`;
      laidOut.value = true; // show the nodes where they are rather than nothing
    }
  }

  if (getCurrentScope()) onScopeDispose(() => tween.dispose()); // (a move that outlives the canvas would draw into a store that is gone)
  settle.watchDrags();

  /** Run a layout once every node is measured: now when they are, else when Vue Flow says they are. `merges`: the expands (spec §6.7) it is for, none for a full layout. */
  async function scheduleLayout(merges: MergeHint[] | null = null): Promise<void> {
    if (!pending) {
      pendingFull = !merges;
      pendingMerges = merges ? [...merges] : [];
    } else if (!merges) pendingFull = true; // a full layout asked for meanwhile covers the expands too
    else pendingMerges.push(...merges); // two expands before the layout ran: it places the cards of both
    pending = true;
    await nextTick();
    if (!vf.vueFlowRef.value) return; // not mounted yet: onNodesInitialized starts the layout once it is
    // New or re-directed nodes: their handles must be measured again before ELK reads them.
    vf.updateNodeInternals(vf.getNodes.value.map((n) => n.id));
    await nextTick();
    if (pending && allMeasured()) await runLayout();
  }
  vf.onNodesInitialized(() => {
    if (pending) void runLayout();
  });
  /** A point of the window (client pixels) in the map's own coordinates: where a card added there is placed. */
  const toFlow = (clientX: number, clientY: number): { x: number; y: number } => vf.screenToFlowCoordinate({ x: clientX, y: clientY });

  /**
   * Resolves true once no layout is waiting or running and no card is moving (the export must not photograph a map half-way to its
   * places), false if that has not happened within `timeoutMs`.
   */
  async function whenSettled(timeoutMs = 2000): Promise<boolean> {
    await nextTick(); // a change made this tick has asked for its layout by now
    if (!busy()) return true;
    // No polling: the layout that ends wakes the waiters (a poll interval is a race against whoever checks just after it ends).
    return new Promise<boolean>((resolve) => {
      const check = () => {
        if (busy()) return;
        clearTimeout(timer);
        settledWaiters.delete(check);
        resolve(true);
      };
      const timer = setTimeout(() => {
        settledWaiters.delete(check);
        resolve(false);
      }, timeoutMs);
      settledWaiters.add(check);
    });
  }

  // ---- viewport ---------------------------------------------------------------------------------
  const fitIds = (ids: string[] | undefined, animate = true) => {
    const present = ids?.filter((id) => vf.findNode(id));
    return vf.fitView({ padding: FIT_PADDING, maxZoom: 1, duration: animate && !reducedMotion() ? 300 : 0, ...(present?.length ? { nodes: present } : {}) });
  };
  /** Frame the focus and what is one process step around it (not the whole family at a tiny zoom). */
  function fitFocus(animate = true): Promise<boolean> {
    const g = map.graph.value;
    const d = map.data.value;
    // A fan has no steps to count: frame its record and the head of the list (the rest is a pan away), not a zoom out to all of it.
    if (g && d?.fan) return fitIds([...fanNodeIds(d, g)].slice(0, FAN_FIT), animate);
    if (!g || !map.focusNodeId.value) return fitIds(undefined, animate);
    return fitIds([...shownNodes(g, map.focusNodeId.value, 1)], animate);
  }
  /** Fit everything drawn (the Fit button). */
  const fit = () => fitIds(undefined);

  /** Re-layout (spec D18): every card back where ELK puts it, including the ones that were dragged. */
  async function relayout(): Promise<void> {
    free = true;
    dragged.clear();
    await scheduleLayout();
  }
  /** A card changed size (a fold, "+N more from the form"): lay out again, but every card stays where it is; room is made round the one that grew. */
  async function reflow(): Promise<void> {
    await scheduleLayout([]);
  }

  // ---- reacting to the page state -----------------------------------------------------------------
  // A new focus (not an expand, which changes the data too): start again, invisible until laid out, then fit around the focus.
  watch(
    () => map.generation.value,
    () => {
      laidOut.value = false;
      needsFit = true;
      placed.clear();
      dragged.clear();
      seen.clear();
      ordered.clear();
      tween.stop();
      token++;
    },
  );
  // The shown set (a Show chip, Reach, a fold, an expand, "+N more") changed: rebuild and lay out what is new. Cards that
  // were already placed keep their places (spec D18); the merge hints say where the new ones go after an expand. Only a
  // new direction lays everything out again, like Re-layout.
  /**
   * ＋ or − on a record card can give the same record another id (a material card `m:<sample>` is the fan root `f:materials:<id>` once its
   * fan is open, and back again on −). The card pressed must keep its place all the same: its replacement is named as the anchor and takes
   * the old one's place (the `from` swap below), pin included.
   */
  function reanchored(hint: MergeHint): MergeHint {
    if (!hint.full || !hint.anchor || map.nodes.value.some((n) => n.id === hint.anchor)) return hint;
    const old = vf.findNode(hint.anchor)?.data as MapNode | undefined;
    if (old?.type !== 'record') return hint;
    const next = map.nodes.value.find((n) => n.type === 'record' && n.ref.collection === old.ref.collection && n.ref.id === old.ref.id && !vf.findNode(n.id));
    return next ? { ...hint, anchor: next.id, from: hint.anchor } : hint;
  }
  let lastDir = map.dir.value;
  let lastShape = '';
  watch([() => map.nodes.value, () => map.dir.value], () => {
    const turned = map.dir.value !== lastDir;
    lastDir = map.dir.value;
    const hints = map.takeMergeHints();
    const shape = edit?.active?.() ? structureKey(map.nodes.value, map.graph.value?.wires ?? []) : '';
    const same = !!shape && shape === lastShape;
    lastShape = shape;
    if (same && !turned && placed.size && vf.getNodes.value.length === map.nodes.value.length) {
      patchInPlace();
      settleSizes();
      return;
    }
    if (turned) dragged.clear();
    const merges = turned || !placed.size ? null : hints.map(reanchored);
    merging = merges?.find((m) => m.anchor) ?? null;
    // A collapsed container that opened may come back under another id (a batch): it takes the old one's place and size.
    for (const merge of merges ?? []) {
      const from = merge.from ? placed.get(merge.from) : undefined;
      if (merge.anchor && from && merge.from !== merge.anchor && !placed.has(merge.anchor)) {
        const was = vf.findNode(merge.from!)?.position ?? from;
        placed.set(merge.anchor, { ...from, x: was.x, y: was.y });
        if (dragged.delete(merge.from!)) dragged.add(merge.anchor); // the pin goes with the card
      }
    }
    // Cards that are gone are forgotten: one that comes back is a new card, placed beside what it is wired to.
    const drawn = new Set(map.nodes.value.map((n) => n.id));
    for (const id of new Set([...placed.keys(), ...dragged])) {
      if (drawn.has(id)) continue;
      placed.delete(id);
      dragged.delete(id);
      ordered.delete(id);
    }
    rebuild();
    merging = null;
    if (map.nodes.value.length) void scheduleLayout(merges);
    // A new wire or a removed one adds a socket to a card or takes one away: where the sockets are is measured again once the layout is done.
    if (edit?.active?.()) settleSizes();
  });
  watch(() => map.focusOfHover.value, applyFocus);
  // Edit mode: the selected card draws its free socket and the others on that side shift along the edge (and the card it leaves takes
  // its spare away), but Vue Flow only knows where a socket is when it is told: measure the two cards once the DOM has them.
  watch(
    () => map.selectedId.value,
    async (now, was) => {
      if (!edit?.active?.()) return;
      const ids = [now, was].filter((id): id is string => !!id && !!vf.findNode(id));
      if (ids.length) await remeasure(...ids);
      settleSizes(); // and every card once the dust has settled (a change of wires moves sockets as well)
    },
  );
  watch(
    () => map.centreRequest.value,
    (req) => {
      const node = req && vf.findNode(req.id);
      if (!node) return;
      const { x, y } = node.computedPosition;
      void vf.setCenter(x + node.dimensions.width / 2, y + node.dimensions.height / 2, { zoom: Math.max(vf.viewport.value.zoom, 0.6), duration: reducedMotion() ? 0 : 300 });
    },
  );

  /** Keyboard focus reached a card that is off the screen: pan to it (a browser would scroll the clipped canvas instead). */
  function reveal(id: string): void {
    // Cards on the move are not where they will be: wait for them (the node is read when they have arrived).
    if (tween.active()) {
      void tween.whenIdle().then(() => reveal(id));
      return;
    }
    const node = vf.findNode(id);
    if (!node) return;
    const { x, y } = node.computedPosition;
    const { width, height } = node.dimensions;
    const v = vf.viewport.value;
    const view = vf.dimensions.value;
    const left = x * v.zoom + v.x;
    const top = y * v.zoom + v.y;
    if (left >= 0 && top >= 0 && left + width * v.zoom <= view.width && top + height * v.zoom <= view.height) return;
    void vf.setCenter(x + width / 2, y + height / 2, { zoom: v.zoom, duration: reducedMotion() ? 0 : 200 });
  }

  /** After a fold or the "+N more" toggle a card changes size: tell Vue Flow, so its sockets and wires follow. */
  async function remeasure(...ids: string[]): Promise<void> {
    await nextTick();
    vf.updateNodeInternals(ids.length ? ids : undefined);
  }

  // ---- the project frame (spec D13) -----------------------------------------------------------------
  /** A box round every drawn node, in flow coordinates; null with nothing drawn or measured. */
  const frame = computed(() => {
    const nodes = vf.getNodes.value.filter((n) => n.dimensions.width > 0);
    if (!nodes.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const n of nodes) {
      const { x, y } = n.computedPosition;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + n.dimensions.width);
      y1 = Math.max(y1, y + n.dimensions.height);
    }
    return { x: x0 - FRAME_PAD, y: y0 - FRAME_PAD - FRAME_LABEL, width: x1 - x0 + FRAME_PAD * 2, height: y1 - y0 + FRAME_PAD * 2 + FRAME_LABEL };
  });

  /** One screen pixel in flow units, so dashed outlines keep their on-screen width at every zoom. */
  const screenPx = computed(() => screenPixel(vf.viewport.value.zoom));

  return { nodeTypes, edgeTypes, laidOut, layoutError, relayout, tidy: settle.tidy, canTidy: settle.canTidy, reflow, fit, fitFocus, remeasure, reveal, frame, screenPx, whenSettled, toFlow };
}
