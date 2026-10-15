// What the pointer is over on the Process map: the hover stack, the wire / socket tooltip (spec D17), what the
// hovered target lights up (§6.3), the sockets whose wires the rail highlights, and the hover card that opens once
// the pointer has rested (spec D16). Split off `useProcessMap`, which owns the graph and the selection.

import { computed, getCurrentInstance, onBeforeUnmount, shallowRef, watch, type ComputedRef } from 'vue';
import { hoverFocus, socketSubjects, type HoverFocus } from './model/hoverFocus';
import { createHoverStack, type Hovered } from './model/hoverStack';
import type { RecordInfo } from './model/recordInfo';
import type { MapNode, ProcessGraph } from './model/types';
import { socketTooltip } from './nodes/wireTooltip';

/** How long the pointer rests on a card before its hover card opens (spec 6.6). */
export const HOVER_DELAY_MS = 250;

/** `<node>:in:<i>` / `<node>:out:<i>`: the id of a socket (a node id never ends so). */
const isSocketId = (id: string): boolean => /:(?:in|out):[^:]+$/.test(id);

export interface HoverDeps {
  graph: ComputedRef<ProcessGraph | null>;
  /** Every node of the graph by id (drawn or not). */
  nodeById: ComputedRef<ReadonlyMap<string, MapNode>>;
  /** The nodes drawn. */
  nodes: ComputedRef<MapNode[]>;
  /** What a record is, for the hover card. */
  info: (id: string) => RecordInfo | null;
}

export function useMapHover({ graph, nodeById, nodes, info }: HoverDeps) {
  const hoverStack = createHoverStack();
  const hovered = shallowRef<Hovered | null>(null);
  const hover = (id: string | null, el?: HTMLElement) => void (hovered.value = hoverStack.hover(id, el));
  const clearHover = () => void (hovered.value = hoverStack.clear());
  // A rebuilt graph removes elements that never see mouseleave.
  watch(graph, () => clearHover());

  /**
   * The hover tooltip (spec D17). A wire: its lines are on the hovered hit path as `data-tip`. A socket:
   * one line per wire on it.
   */
  const tooltip = computed(() => {
    const h = hovered.value;
    const g = graph.value;
    if (!h || !g) return null;
    if (g.wires.some((w) => w.id === h.id)) {
      const tip = h.el?.dataset?.tip;
      return tip ? { id: h.id, lines: tip.split('\n'), el: h.el, wire: true } : null;
    }
    if (!nodeById.value.has(h.id) && isSocketId(h.id)) {
      const drawn = new Map(nodes.value.map((n) => [n.id, n]));
      return { id: h.id, lines: socketTooltip(h.id, g.wires, drawn), el: h.el, wire: false };
    }
    return null;
  });

  /** What the pointer's target lights up: its wires, and everything else dimmed (spec §6.3). */
  const focusOfHover = computed<HoverFocus | null>(() => (graph.value ? hoverFocus(graph.value, hovered.value?.id ?? null) : null));

  /** While a socket is hovered: the node ids its wires touch, which the rail's Connections highlight (spec D17). */
  const socketHighlight = computed<ReadonlySet<string>>(() => {
    const id = hovered.value?.id;
    const g = graph.value;
    return id && g && !nodeById.value.has(id) && isSocketId(id) ? socketSubjects(g, id) : new Set<string>();
  });

  /** The hover card (spec D16): the hovered card or slot, once the pointer has rested on it for 250 ms. */
  const card = shallowRef<{ id: string; el: HTMLElement; info: RecordInfo } | null>(null);
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  if (getCurrentInstance()) onBeforeUnmount(() => cardTimer && clearTimeout(cardTimer));
  /** The next hover raises its card at once (a long press on a phone has waited already) instead of after the rest. */
  let cardNow = false;
  const holdHover = (id: string, el: HTMLElement) => {
    cardNow = true;
    hover(id, el);
  };
  watch(hovered, (h) => {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = null;
    card.value = null;
    const held = cardNow;
    const delay = held ? 0 : HOVER_DELAY_MS;
    cardNow = false;
    if (!h?.el) return;
    // A full container says on its face what its hover card would (the rail has the rest): no card for it, except
    // on a long press (a phone has no rail beside the map).
    const n = nodeById.value.get(h.id);
    if (!held && n?.type === 'container' && !n.collapsed) return;
    const resting = h;
    cardTimer = setTimeout(() => {
      cardTimer = null;
      const now = hovered.value;
      const found = now && now.id === resting.id && now.el ? info(now.id) : null;
      if (found && now?.el) card.value = { id: now.id, el: now.el, info: found };
    }, delay);
  });

  return { hovered, hover, holdHover, clearHover, tooltip, focusOfHover, socketHighlight, card };
}
