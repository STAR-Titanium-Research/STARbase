// The Process map's Vue Flow canvas: turns the shown nodes into Vue Flow nodes and edges, lays them out
// with ELK once Vue Flow has measured them, animates them to their places, and keeps the project frame
// (spec D13) round them. Everything about *what* is shown lives in useProcessMap; this is the drawing.
//
// Layout runs only on measured sizes: Vue Flow reports 0x0 until a node is mounted and measured, so a
// layout waits for `onNodesInitialized` (and elkInput treats a non-positive size as unmeasured).

import { computed, markRaw, nextTick, ref, watch } from 'vue';
import { useVueFlow, type Edge, type GraphNode, type Node, type NodeTypesObject, type EdgeTypesObject } from '@vue-flow/core';
import { nodeOfSocket } from './model/sockets';
import { shownNodes } from './model/reach';
import type { MapNode } from './model/types';
import ContainerNode from './nodes/ContainerNode.vue';
import JunctionNode from './nodes/JunctionNode.vue';
import RecordNode from './nodes/RecordNode.vue';
import WireEdge from './nodes/WireEdge.vue';
import { KINDS } from './nodes/kinds';
import { wireTooltip } from './nodes/wireTooltip';
import type { useProcessMap } from './useProcessMap';
import { useElkLayout } from './useElkLayout';

type ProcessMap = ReturnType<typeof useProcessMap>;

const nodeTypes = { record: markRaw(RecordNode), container: markRaw(ContainerNode), junction: markRaw(JunctionNode) } as unknown as NodeTypesObject;
const edgeTypes = { wire: markRaw(WireEdge) } as unknown as EdgeTypesObject;

/** Duration of the move to the laid-out positions. */
const MOVE_MS = 200;
/** Room round the nodes for the project frame and its label. */
const FRAME_PAD = 28;
const FRAME_LABEL = 30;
const FIT_PADDING = 0.12;

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
  let token = 0;
  /** Where the last layout put each node, for nodes that are rebuilt (hidden chips, folds) but were not dragged. */
  const placed = new Map<string, { x: number; y: number }>();

  // ---- elements ---------------------------------------------------------------------------------
  function elements(): { nodes: Node[]; edges: Edge[] } {
    const list = map.nodes.value;
    const byId = new Map(list.map((n) => [n.id, n]));
    const nodes: Node[] = list.map((n) => ({
      id: n.id,
      type: n.type,
      position: vf.findNode(n.id)?.position ?? placed.get(n.id) ?? { x: 0, y: 0 },
      data: n,
      draggable: true,
      selectable: false,
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

  function rebuild(): void {
    const { nodes, edges } = elements();
    vf.setNodes(nodes);
    vf.setEdges(edges);
    syncSelection();
  }

  // ---- layout -----------------------------------------------------------------------------------
  const measuredSize = (n: GraphNode) => (n.dimensions.width > 0 && n.dimensions.height > 0 ? { width: n.dimensions.width, height: n.dimensions.height } : null);
  const allMeasured = () => vf.getNodes.value.length > 0 && vf.getNodes.value.every((n) => measuredSize(n));

  /** Move every node to `target`, over MOVE_MS (instantly for people who asked for less motion). */
  function moveTo(target: Record<string, { x: number; y: number }>): Promise<void> {
    const start = new Map(vf.getNodes.value.map((n) => [n.id, { ...n.position }]));
    const apply = (t: number) =>
      vf.applyNodeChanges(
        Object.entries(target).map(([id, to]) => {
          const from = start.get(id) ?? to;
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
    const mine = ++token;
    pending = false;
    const graph = map.graph.value;
    if (!graph || !vf.getNodes.value.length) return;
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const n of vf.getNodes.value) {
      const s = measuredSize(n);
      if (s) sizes[n.id] = s;
    }
    try {
      const positions = await layout(graph, new Set(vf.getNodes.value.map((n) => n.id)), sizes, map.dir.value);
      if (mine !== token) return; // a newer layout (or a new family) supersedes this one
      layoutError.value = '';
      for (const [id, p] of Object.entries(positions)) placed.set(id, p);
      await moveTo(positions);
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

  /** Run a layout once every node is measured: now when they are, else when Vue Flow says they are. */
  async function scheduleLayout(): Promise<void> {
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

  // ---- viewport ---------------------------------------------------------------------------------
  const fitIds = (ids: string[] | undefined, animate = true) => {
    const present = ids?.filter((id) => vf.findNode(id));
    return vf.fitView({ padding: FIT_PADDING, maxZoom: 1, duration: animate && !reducedMotion() ? 300 : 0, ...(present?.length ? { nodes: present } : {}) });
  };
  /** Frame the focus and what is one process step around it (not the whole family at a tiny zoom). */
  function fitFocus(animate = true): Promise<boolean> {
    const g = map.graph.value;
    if (!g || !map.focusNodeId.value) return fitIds(undefined, animate);
    return fitIds([...shownNodes(g, map.focusNodeId.value, 1)], animate);
  }
  /** Fit everything drawn (the Fit button). */
  const fit = () => fitIds(undefined);

  /** Re-layout (spec D18): every card back where ELK puts it, including the ones that were dragged. */
  async function relayout(): Promise<void> {
    await scheduleLayout();
  }

  // ---- reacting to the page state -----------------------------------------------------------------
  // A new family: start again, invisible until laid out, then fit around the focus.
  watch(
    () => map.data.value,
    () => {
      laidOut.value = false;
      needsFit = true;
      placed.clear();
      token++;
    },
  );
  // The shown set, the Show chips, a fold or the direction changed: rebuild and lay out again.
  watch([() => map.nodes.value, () => map.dir.value], () => {
    rebuild();
    if (map.nodes.value.length) void scheduleLayout();
  });
  watch(() => map.selectedId.value, syncSelection);
  watch(
    () => map.centreRequest.value,
    (req) => {
      const node = req && vf.findNode(req.id);
      if (!node) return;
      const { x, y } = node.computedPosition;
      void vf.setCenter(x + node.dimensions.width / 2, y + node.dimensions.height / 2, { zoom: Math.max(vf.viewport.value.zoom, 0.6), duration: reducedMotion() ? 0 : 300 });
    },
  );

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

  return { nodeTypes, edgeTypes, laidOut, layoutError, relayout, fit, fitFocus, remeasure, frame };
}

