// The Process map's Vue Flow canvas: turns the shown nodes into Vue Flow nodes and edges, lays them out
// with ELK once Vue Flow has measured them, animates them to their places, and keeps the project frame
// (spec D13) round them. Everything about *what* is shown lives in useProcessMap; this is the drawing.
//
// Layout runs only on measured sizes: Vue Flow reports 0x0 until a node is mounted and measured, so a
// layout waits for `onNodesInitialized` (and elkInput treats a non-positive size as unmeasured).

import { computed, markRaw, nextTick, ref, watch } from 'vue';
import { useVueFlow, type Edge, type GraphNode, type Node, type NodeTypesObject, type EdgeTypesObject } from '@vue-flow/core';
import { nodeOfSocket } from './model/sockets';
import { fanNodeIds } from './model/fans';
import { placeMerged, type Box } from './model/placeMerged';
import { shownNodes } from './model/reach';
import type { MapNode } from './model/types';
import ContainerNode from './nodes/ContainerNode.vue';
import JunctionNode from './nodes/JunctionNode.vue';
import RecordNode from './nodes/RecordNode.vue';
import WireEdge from './nodes/WireEdge.vue';
import { cardLabel } from './nodes/a11y';
import { KINDS } from './nodes/kinds';
import { wireTooltip } from './nodes/wireTooltip';
import MoreNode from './nodes/MoreNode.vue';
import type { MergeHint, useProcessMap } from './useProcessMap';
import { useElkLayout } from './useElkLayout';

type ProcessMap = ReturnType<typeof useProcessMap>;

const nodeTypes = { record: markRaw(RecordNode), container: markRaw(ContainerNode), junction: markRaw(JunctionNode), more: markRaw(MoreNode) } as unknown as NodeTypesObject;
const edgeTypes = { wire: markRaw(WireEdge) } as unknown as EdgeTypesObject;

/** Duration of the move to the laid-out positions. */
const MOVE_MS = 200;
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

export function useMapCanvas(map: ProcessMap) {
  const vf = useVueFlow();
  const { layout } = useElkLayout();

  /** False until the first layout of a freshly loaded family has run: the canvas stays invisible so nodes do not flash at 0,0. */
  const laidOut = ref(false);
  const layoutError = ref('');
  let needsFit = true;
  let pending = false;
  /** Layouts (and the move to their places) in progress: the export waits for none (whenSettled). */
  let running = 0;
  const busy = () => pending || running > 0;
  const settledWaiters = new Set<() => void>();
  const notifySettled = () => [...settledWaiters].forEach((check) => check());
  /** The pending layout is an expand (new cards go beside what is placed), not a full layout; a full one wins when both are asked for. */
  let pendingMerges: MergeHint[] = [];
  let pendingFull = true;
  let token = 0;
  /** Where the last layout put each node and how big it was then: for nodes that are rebuilt (hidden chips, folds) but were not dragged, and to tell cards that are new, or that grew. */
  const placed = new Map<string, Box>();
  /** Cards the person dragged this visit: they stay where they were dropped, whatever else changes, until Re-layout, a new direction or a new focus. */
  const dragged = new Set<string>();
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
  function elements(): { nodes: Node[]; edges: Edge[] } {
    const list = map.nodes.value;
    const byId = new Map(list.map((n) => [n.id, n]));
    const nodes: Node[] = list.map((n) => ({
      id: n.id,
      type: n.type,
      position: vf.findNode(n.id)?.position ?? atPlaced(n.id) ?? startOfMerge() ?? { x: 0, y: 0 },
      data: n,
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

  /** The selected card is Vue Flow's `selected` (the components draw it focal); selection itself is the page's, not Vue Flow's. */
  function syncSelection(): void {
    const id = map.selectedId.value;
    vf.applyNodeChanges(vf.getNodes.value.map((n) => ({ id: n.id, type: 'select' as const, selected: n.id === id })));
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

  function rebuild(): void {
    const { nodes, edges } = elements();
    vf.setNodes(nodes);
    vf.setEdges(edges);
    syncSelection();
    applyFocus();
  }

  // ---- layout -----------------------------------------------------------------------------------
  const measuredSize = (n: GraphNode) => (n.dimensions.width > 0 && n.dimensions.height > 0 ? { width: n.dimensions.width, height: n.dimensions.height } : null);
  const allMeasured = () => vf.getNodes.value.length > 0 && vf.getNodes.value.every((n) => measuredSize(n));

  /** Move the nodes of `target`, over MOVE_MS (instantly for people who asked for less motion, and for `instant` ones: new cards do not fly in). */
  function moveTo(target: Record<string, { x: number; y: number }>, instant: ReadonlySet<string> = new Set()): Promise<void> {
    const start = new Map(vf.getNodes.value.map((n) => [n.id, { ...n.position }]));
    const apply = (t: number) =>
      vf.applyNodeChanges(
        Object.entries(target).map(([id, to]) => {
          const from = instant.has(id) ? to : (start.get(id) ?? to);
          return { id, type: 'position' as const, from, position: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t } };
        }),
      );
    if (reducedMotion() || typeof requestAnimationFrame === 'undefined') {
      apply(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / MOVE_MS);
        apply(1 - (1 - t) ** 2);
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function runLayout(): Promise<void> {
    running++;
    try {
      await layoutOnce();
    } finally {
      running--;
      notifySettled();
    }
  }

  async function layoutOnce(): Promise<void> {
    const mine = ++token;
    pending = false;
    // An expand lays out only what is new (spec §6.7); a first layout, Re-layout and a new direction lay out everything.
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
      const instant = new Set<string>();
      if (merges) {
        // Cards already placed stay where they are (a dragged one stays where it was dropped): only new cards, and cards a grown one pushed, move.
        const here: Record<string, Box> = {};
        for (const n of vf.getNodes.value) {
          const was = placed.get(n.id);
          if (was && (dragged.has(n.id) || !merges.some((m) => m.replace?.includes(n.id)))) here[n.id] = { x: n.position.x, y: n.position.y, width: was.width, height: was.height };
        }
        const wires = graph.wires.map((w) => ({ from: nodeOfSocket(w.from), to: nodeOfSocket(w.to) }));
        positions = placeMerged({ elk, sizes, placed: here, edges: wires, dir: map.dir.value, anchors: merges.flatMap((m) => (m.anchor ? [m.anchor] : [])), pinned: dragged });
        for (const id of Object.keys(positions)) if (!here[id]) instant.add(id);
      }
      for (const n of vf.getNodes.value) {
        const at = positions[n.id] ?? (merges ? n.position : undefined);
        const size = sizes[n.id];
        if (at && size) placed.set(n.id, { x: at.x, y: at.y, ...size });
      }
      await moveTo(positions, instant);
      if (mine !== token) return;
      laidOut.value = true;
      if (needsFit) {
        needsFit = false;
        await fitFocus(false); // the first view of a family: no glide from the default viewport
      }
    } catch (e) {
      if (mine !== token) return;
      layoutError.value = `Could not lay out the map: ${e instanceof Error ? e.message : String(e)}`;
      laidOut.value = true; // show the nodes where they are rather than nothing
    }
  }

  vf.onNodeDragStop((e) => {
    for (const n of e.nodes) dragged.add(n.id);
  });

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
      token++;
    },
  );
  // The shown set (a Show chip, Reach, a fold, an expand, "+N more") changed: rebuild and lay out what is new. Cards that
  // were already placed keep their places (spec D18); the merge hints say where the new ones go after an expand. Only a
  // new direction lays everything out again, like Re-layout.
  let lastDir = map.dir.value;
  watch([() => map.nodes.value, () => map.dir.value], () => {
    const turned = map.dir.value !== lastDir;
    lastDir = map.dir.value;
    const hints = map.takeMergeHints();
    if (turned) dragged.clear();
    const merges = turned || !placed.size ? null : hints;
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
    }
    rebuild();
    merging = null;
    if (map.nodes.value.length) void scheduleLayout(merges);
  });
  watch(() => map.selectedId.value, syncSelection);
  watch(() => map.focusOfHover.value, applyFocus);
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

  return { nodeTypes, edgeTypes, laidOut, layoutError, relayout, reflow, fit, fitFocus, remeasure, reveal, frame, whenSettled };
}
