// The Process map's state: the focus (from the URL), the loaded family, the graph built from it, what is
// shown (reach, Show chips, expanded cards) and what is selected. The page (ProcessMapPage.vue) draws it; the rail /
// hover card read `selected`, `hovered`, `tooltip`. Through the host's `api` only, like the model (spec §7).
//
// Split along its seams: `useMapExpand` (＋ and "+N more"), `useMapHover` (pointer, tooltip, hover card),
// `model/loadFocus` (what opening on a record loads), `model/showChips` (the Show chips).

import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { errorText, isNotVisible, useRequestGate, type HostApi } from '@d1/ui';
import { buildGraph, fanRootId } from './model/buildGraph';
import { COLLECTION, focusPlan, slotKindOf, stepCollection } from './model/collections';
import { connectionsOf, type Connections } from './model/connections';
import { FALLBACK_RELATIONS, formSlots } from './model/formSlots';
import { groupBatches } from './model/groupBatches';
import { chainFocus, type ChainDir, type HoverFocus } from './model/hoverFocus';
import { fanNodeIds, fanRowIds } from './model/fans';
import { parseFocus } from './model/loadFamily';
import { NoSample, loadFocus, type DefsByKind } from './model/loadFocus';
import { CARD_CAP, fitReach, type Reach } from './model/reach';
import { HIDEABLE, SETTINGS_CHIP, drawnNodes, presentKinds as presentKindsOf, readRemembered, writeRemembered } from './model/showChips';
import { flipKeys, keysOfGroup, nodesWithKey, resolveSelection, selectionKey } from './model/viewState';
import { recordInfo, type RecordInfo } from './model/recordInfo';
import type { MapNode, MapStatus, ProcessData, ProcessGraph, Ref } from './model/types';
import { refKey } from './nodes/actions';
import type { Dir } from './model/elkInput';
import { useMapExpand } from './useMapExpand';
import { useMapHover } from './useMapHover';

const DEFAULT_REACH: Reach = 2;

/** The route and router the map needs: kept to what it uses so tests can fake them. */
export interface MapRoute {
  path: string;
  query: Record<string, unknown>;
}
export interface MapRouter {
  replace(to: { path: string; query: Record<string, string> }): unknown;
}

/**
 * Edit mode's part in the map (spec §7.1): the draft is merged into the loaded data (toGraph) and drawn through buildGraph and ELK like
 * any other record. Supplied by useEditMode; a map without edit mode passes none.
 */
export interface MapOverlay {
  /** The draft is on the map (edit mode, or a draft opened read-only on a phone). */
  active(): boolean;
  /** A blank canvas: edit mode with no record to map, so the map is ready with only the draft on it. */
  blank(): boolean;
  /** The data with the draft merged in. `data` is null on a blank canvas. */
  merge(data: ProcessData | null): ProcessData;
  /** Nodes of the draft are always drawn, whatever the reach and the Show chips say. */
  keep(node: MapNode): boolean;
}

export interface Selected {
  /** The record the rail shows. */
  ref: Ref;
  /** The card kind (`sample`, `operation`, `test`, `equipment`...). */
  kind: string;
}

const first = (v: unknown): string | undefined => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' ? v : undefined);

function parseReach(v: string | undefined): Reach {
  if (v === 'all') return 'all';
  return v === '1' || v === '2' || v === '3' ? (Number(v) as Reach) : DEFAULT_REACH;
}

export function useProcessMap(api: HostApi, route: MapRoute, router: MapRouter, overlay?: MapOverlay) {
  const gate = useRequestGate();
  if (getCurrentInstance()) onBeforeUnmount(() => gate.cancel());

  // ---- the address (spec D25) -------------------------------------------------------------------
  const focus = computed(() => parseFocus(first(route.query.focus)) ?? (first(route.query.sample) ? { collection: COLLECTION.sample, id: first(route.query.sample)! } : null));
  const focusKey = computed(() => (focus.value ? `${focus.value.collection}:${focus.value.id}` : ''));
  const reach = ref<Reach>(parseReach(first(route.query.reach)));
  watch(
    () => first(route.query.reach),
    (v) => void (reach.value = parseReach(v)),
  );

  /** The query of the page's own path without the keys `drop` names (and without the legacy `sample`), as strings. */
  function queryWithout(...drop: string[]): Record<string, string> {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      const s = first(v);
      if (s !== undefined && k !== 'sample' && !drop.includes(k)) query[k] = s;
    }
    return query;
  }
  /** `router.replace` on the page's own path (so it holds in both hosts), keeping other query keys; `sample` becomes `focus`. */
  function writeUrl(patch: Record<string, string>): void {
    const query = queryWithout();
    if (focusKey.value) query.focus = focusKey.value;
    void router.replace({ path: route.path, query: { ...query, ...patch } });
  }
  /** The Finder picked a record: load it into the map (reach kept). */
  function setFocus(collection: string, id: string): void {
    void router.replace({ path: route.path, query: { ...queryWithout(), focus: `${collection}:${id}`, reach: String(reach.value) } });
  }
  /** The Finder picked a record: the map takes one it can open, and declines the rest (false), so the Finder navigates as it does anywhere else. */
  function pickRecord(record: { collection: string; id: string }): boolean {
    if (!focusPlan(record.collection)) return false;
    setFocus(record.collection, record.id);
    return true;
  }
  /** "Clear": back to the search-first page, keeping the other query keys. */
  function clearFocus(): void {
    void router.replace({ path: route.path, query: queryWithout('focus') });
  }
  function setReach(r: Reach): void {
    reach.value = r;
    // A fan has no reach, and the cards ＋ opened from a fan item (a side fan's) are not part of any reach: they stay.
    if (!data.value?.fan && !data.value?.sideFans?.length) {
      revealedKeys.value = new Set();
      expansion.forgetReveals(); // a ＋ that only showed cards has nothing left to take away
    }
    // Whether the cap is what limits the map now, from what is drawn (kept cards may still fill it).
    capped.value = shown.value.size >= CARD_CAP;
    writeUrl({ reach: String(r) });
  }

  // ---- Show chips (spec D14, D25) ---------------------------------------------------------------
  const remembered = readRemembered();
  const hiddenKinds = ref<ReadonlySet<string>>(new Set(remembered.hidden));
  const probable = ref(remembered.probable);
  const stack = ref(remembered.stack);
  /**
   * The stacks the person took apart with "Unstack" (or a double-click), each as the row ids it held: a double-click on one of its passes
   * stacks that one again; the Stack passes chip, turned on again, stacks them all again.
   */
  const unstackedGroups = ref<readonly (readonly string[])[]>([]);
  /** Every operation of those stacks: they never join a stack while they are unstacked. */
  const unstacked = computed<ReadonlySet<string>>(() => new Set(unstackedGroups.value.flat()));
  const remember = () => writeRemembered({ hidden: [...hiddenKinds.value], probable: probable.value, stack: stack.value });
  function toggleKind(kind: string): void {
    if (!HIDEABLE.has(kind)) return;
    const next = new Set(hiddenKinds.value);
    if (!next.delete(kind)) next.add(kind);
    hiddenKinds.value = next;
    remember();
  }
  function setProbable(on: boolean): void {
    probable.value = on;
    remember();
  }
  function setStack(on: boolean): void {
    stack.value = on;
    if (on) unstackedGroups.value = [];
    remember();
  }
  /** The card of the graph as it is now that holds row `rowId`. */
  const cardOfRow = (rowId: string) => graph.value?.nodes.find((n) => n.type === 'container' && n.group.rowIds.includes(rowId))?.id;
  /**
   * "Unstack" on a stack of passes (the rail's button, or a double-click on the stack): each pass becomes its own card again. The map is laid
   * out in full, like ＋, round the stack's first pass, which takes the stack's place so the others slide out from it.
   */
  function unstack(id: string): void {
    const n = nodeById.value.get(id);
    if (n?.type !== 'container' || !n.stacked) return;
    unstackedGroups.value = [...unstackedGroups.value, [...n.group.rowIds]];
    const anchor = cardOfRow(n.group.rowIds[0]);
    if (anchor) expansion.hint({ anchor, from: id, full: true });
  }
  /** A double-click on a pass of an unstacked stack: that whole stack stacks again, the stack taking the place of the pass pressed. */
  function restack(id: string): void {
    const n = nodeById.value.get(id);
    if (n?.type !== 'container' || n.stacked) return;
    const rest = unstackedGroups.value.filter((g) => !g.some((rowId) => n.group.rowIds.includes(rowId)));
    if (rest.length === unstackedGroups.value.length) return;
    unstackedGroups.value = rest;
    const anchor = cardOfRow(n.group.rowIds[0]);
    if (anchor) expansion.hint({ anchor, from: id, full: true });
  }

  // ---- what the page asks for ---------------------------------------------------------------------
  const dir = ref<Dir>('RIGHT');
  const setDir = (d: Dir) => void (dir.value = d);

  const status = ref<MapStatus>('empty');
  const error = ref('');
  const data = shallowRef<ProcessData | null>(null);
  /** What is drawn: the loaded data with the draft merged in (edit mode), else the loaded data itself. */
  const shownData = computed<ProcessData | null>(() => (overlay?.active() && (data.value || !focus.value) ? overlay.merge(data.value) : data.value));
  const defs = shallowRef<DefsByKind>({ operation: FALLBACK_RELATIONS.operation, test: FALLBACK_RELATIONS.test, runtime: false });
  // What the person did to cards is kept under stable keys (model/viewState.ts), not node ids: the Probable
  // batches chip regroups rows into containers with other ids, and the person's work must survive that.
  const unfoldedKeys = ref<ReadonlySet<string>>(new Set());
  const moreOpenKeys = ref<ReadonlySet<string>>(new Set());
  /** Cards the person revealed with ＋ beyond what the reach shows. */
  const revealedKeys = ref<ReadonlySet<string>>(new Set());
  const selectedKey = ref<string | null>(null);
  /** The last expand could not add everything: the 300-card cap (spec D22) stopped it. */
  const capped = ref(false);
  /** Counts focus loads: the canvas starts afresh on a new one, not on an expand (which changes `data` too). */
  const generation = ref(0);
  /** What the last expand said, when it could not do what was asked (an error keeps what is loaded, spec §7). */
  const notice = ref('');
  /** Expands in flight. */
  const expanding = ref(0);
  const centreRequest = shallowRef<{ id: string; n: number } | null>(null);

  async function load(): Promise<void> {
    const token = gate.begin();
    expansion.reset(token);
    generation.value++;
    data.value = null;
    unfoldedKeys.value = new Set();
    moreOpenKeys.value = new Set();
    revealedKeys.value = new Set();
    unstackedGroups.value = [];
    capped.value = false;
    notice.value = '';
    selectedKey.value = null;
    clearHover();
    error.value = '';
    const f = focus.value;
    if (!f) {
      // A blank canvas (edit mode with nothing to map) is a map with only the draft on it.
      status.value = overlay?.blank() ? 'ready' : 'empty';
      return;
    }
    const plan = focusPlan(f.collection);
    if (!plan) {
      status.value = 'error';
      error.value = 'The Process map cannot open on this kind of record.';
      return;
    }
    status.value = 'loading';
    try {
      const loaded = await loadFocus(api, f, plan);
      if (!gate.isCurrent(token)) return;
      defs.value = loaded.defs;
      data.value = loaded.data;
      expansion.loaded(plan === 'fan' ? { fan: `${f.collection}:${f.id}` } : { families: loaded.data.samples.map((s) => s.id) });
      // A step is selected by its own row, which any container holding it answers to (a probable batch's id changes with the chip).
      const fd = loaded.data.focus;
      selectedKey.value = fd.kind === 'operation' || fd.kind === 'test' ? `${fd.kind}:${fd.id}` : focusNodeId.value || null;
      status.value = 'ready';
    } catch (e) {
      if (!gate.isCurrent(token)) return;
      if (isNotVisible(e)) status.value = 'notVisible';
      else {
        status.value = 'error';
        error.value = e instanceof NoSample ? e.message : `Could not load the Process map: ${errorText(e)}`;
      }
    }
  }

  // ---- the graph ----------------------------------------------------------------------------------
  /** The graph of `d`. Steps still collapsed in a fan are drawn by buildGraph's fan mode, not grouped into batches. */
  function graphOf(d: ProcessData): ProcessGraph {
    const collapsed = fanRowIds(d);
    const groups = groupBatches(
      d.operations.filter((o) => !collapsed.has(o.id)),
      d.tests.filter((t) => !collapsed.has(t.id)),
      { probable: probable.value, batchCodes: d.batchCodes, stack: stack.value, unstacked: unstacked.value },
    );
    const unfolded = new Set(groups.filter((g) => keysOfGroup(g).some((k) => unfoldedKeys.value.has(k))).map((g) => g.id));
    // Wires between the passes of an unstacked stack are drawn striped only while the chip would stack passes at all.
    return buildGraph(d, groups, { slots: (row, kind) => formSlots(row, kind, defs.value[kind]), unfolded, unstackedGroups: stack.value ? unstackedGroups.value : [] });
  }
  const graph = computed<ProcessGraph | null>(() => (shownData.value ? graphOf(shownData.value) : null));

  const focusProjectId = computed(() => {
    const d = shownData.value;
    if (!d) return null;
    const { kind, id } = d.focus;
    if (kind === 'sample') return d.samples.find((s) => s.id === id)?.projectId ?? null;
    if (kind === 'operation') return d.operations.find((o) => o.id === id)?.projectId ?? null;
    if (kind === 'test') return d.tests.find((t) => t.id === id)?.projectId ?? null;
    return kind === 'project' ? id : null;
  });
  /** The node the map is focused on: the sample's card, the step's container (in whichever batch it is), the record a fan hangs from. */
  const focusNodeId = computed(() => {
    const d = shownData.value;
    const g = graph.value;
    if (!d || !g) return '';
    const { kind, id } = d.focus;
    if (kind === 'sample') return `s:${id}`;
    if (kind === 'operation' || kind === 'test') return g.nodes.find((n) => n.type === 'container' && n.kind === kind && n.group.rowIds.includes(id))?.id ?? '';
    return fanRootId(d.focus);
  });

  const fitted = computed(() => {
    const g = graph.value;
    const d = shownData.value;
    if (!g || !d || !focusNodeId.value) return { ids: new Set<string>(), effective: reach.value, clamped: false };
    // What a fan lists is always drawn. A fan has no reach (it has no steps to count), so only fans are shown.
    const fans = fanNodeIds(d, g);
    if (d.fan) return { ids: fans, effective: reach.value, clamped: false };
    const r = fitReach(g, focusNodeId.value, reach.value);
    return fans.size ? { ...r, ids: new Set([...r.ids, ...fans]) } : r;
  });
  const effectiveReach = computed(() => fitted.value.effective);
  /** The banner "Showing part of this history" (spec D22). */
  const partial = computed(() => !!shownData.value?.truncated || fitted.value.clamped || capped.value);

  const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map((n) => [n.id, n])));
  /** The nodes of the graph the person revealed or opened, by their stable keys. */
  const revealed = computed(() => nodesWithKey(graph.value?.nodes ?? [], revealedKeys.value));
  const moreOpen = computed<ReadonlySet<string>>(() => nodesWithKey(graph.value?.nodes ?? [], moreOpenKeys.value));
  /** The selected node's id in the graph as it is now. */
  const selectedId = computed(() => resolveSelection(selectedKey.value, graph.value?.nodes ?? []));

  /** The cards a Show chip never hides: the focus, and the record each fan hangs from (a remembered "Tool" chip must not empty a tool's fan). */
  const pinned = computed(() => {
    const d = shownData.value;
    const out = new Set<string>(focusNodeId.value ? [focusNodeId.value] : []);
    if (d) for (const f of [d.fan && { root: d.focus }, ...(d.sideFans ?? [])]) if (f) out.add(fanRootId(f.root));
    return out;
  });

  /** Node ids drawn: the reach, plus what ＋ revealed, minus the hidden Show chips. */
  const shown = computed(() => {
    const ids = new Set([...fitted.value.ids, ...revealed.value]);
    for (const id of ids) {
      const n = nodeById.value.get(id);
      if (n?.type === 'record' && hiddenKinds.value.has(n.kind) && !pinned.value.has(id)) ids.delete(id);
    }
    // What is in the draft is always drawn: it is what is being built, wherever it sits relative to the focus.
    if (overlay?.active()) for (const n of graph.value?.nodes ?? []) if (overlay.keep(n)) ids.add(n.id);
    return ids;
  });

  /** The projects the loaded rows name, by id: what a card of another project is tagged with. */
  const projectRefs = computed(() => {
    const out = new Map<string, Ref>();
    for (const row of [...(shownData.value?.operations ?? []), ...(shownData.value?.tests ?? [])]) {
      const r = row.relations.project_id;
      if (r && r.code && !out.has(r.id)) out.set(r.id, r);
    }
    return out;
  });

  /** The shown nodes with the Show chips applied to their Inside slots and key settings, and other projects tagged. */
  const nodes = computed<MapNode[]>(() =>
    drawnNodes(
      (graph.value?.nodes ?? []).filter((n) => shown.value.has(n.id)),
      hiddenKinds.value,
      focusProjectId.value,
      projectRefs.value,
    ),
  );
  const presentKinds = computed(() => presentKindsOf(graph.value?.nodes ?? []));

  // ---- project frame (spec D13) -----------------------------------------------------------------
  /** The focus sample's project, named by an operation or test that carries it; null when no row does. */
  const project = computed(() => {
    const d = shownData.value;
    const id = focusProjectId.value;
    if (!d || !id) return null;
    if (d.focus.kind === 'project') return d.focus;
    for (const row of [...d.operations, ...d.tests]) {
      const r = row.relations.project_id;
      if (r && r.id === id) return r;
    }
    return { collection: 'projects', id, code: '' } satisfies Ref;
  });

  // ---- selection ----------------------------------------------------------------------------------
  /** The record behind an id of the actions: a node id, or a slot's `<collection>:<id>`. */
  function recordOf(id: string): Selected | null {
    const d = shownData.value;
    const n = nodeById.value.get(id);
    if (n?.type === 'record') return { ref: n.ref, kind: n.kind };
    if (n?.type === 'container' && d) {
      const rowId = n.rows[0]?.recordId ?? n.group.rowIds[0];
      const row = n.kind === 'operation' ? d.operations.find((o) => o.id === rowId) : d.tests.find((t) => t.id === rowId);
      if (!row) return null;
      return { ref: { collection: stepCollection(n.kind), id: row.id, code: row.code }, kind: n.kind };
    }
    if (n?.type === 'junction') return recordOf(`s:${n.parentId}`);
    for (const c of graph.value?.nodes ?? []) {
      if (c.type !== 'container') continue;
      for (const s of c.slots) {
        for (const r of s.ref ? [s.ref] : (s.values ?? [])) {
          if (refKey(r) === id) return { ref: r, kind: slotKindOf(r.collection) ?? 'data_file' };
        }
      }
    }
    return null;
  }
  const selected = computed(() => (selectedId.value ? recordOf(selectedId.value) : null));
  const selectedRefKey = computed(() => (selected.value ? refKey(selected.value.ref) : null));

  let centreCount = 0;
  function select(id: string, opts: { centre?: boolean } = {}): void {
    selectedKey.value = selectionKey(id, graph.value?.nodes ?? []);
    if (opts.centre) centreRequest.value = { id, n: ++centreCount };
  }

  const toggleRows = (id: string) => {
    const n = nodeById.value.get(id);
    if (!n) return;
    unfoldedKeys.value = flipKeys(unfoldedKeys.value, n);
    // The container's sockets are other sockets now (each row its own, or the bundle again), in row order: the cards on them
    // swap places until their order follows the sockets' and no wire crosses. Dragged cards stay, and nothing further away moves.
    expansion.hint({ reslot: id });
  };
  const toggleMore = (id: string) => {
    const n = nodeById.value.get(id);
    if (n) moreOpenKeys.value = flipKeys(moreOpenKeys.value, n);
  };

  // ---- what the rail and the hover card say --------------------------------------------------------
  /** What a record (a node id, or a record inside a card) is: facts, counts, data to ask about. Null when the map does not know it. */
  const info = (id: string): RecordInfo | null => (shownData.value && graph.value ? recordInfo(shownData.value, graph.value, id) : null);
  const selectedInfo = computed(() => (selectedId.value ? info(selectedId.value) : null));
  /** The selected record's connections, grouped for the rail. */
  const connections = computed<Connections>(() => (graph.value && selectedId.value ? connectionsOf(graph.value, selectedId.value) : {}));
  /** Is the selected record a card on the map (Expand and Centre act on cards). */
  const selectedOnMap = computed(() => !!selectedId.value && shown.value.has(selectedId.value));

  /** Nodes with records the person may not read on a side (spec D21): they draw "some records hidden" there. */
  const hiddenSides = computed(() => {
    const out = new Map<string, Set<'in' | 'out'>>();
    for (const m of graph.value?.hidden ?? []) {
      const sides = out.get(m.nodeId) ?? new Set<'in' | 'out'>();
      sides.add(m.side);
      out.set(m.nodeId, sides);
    }
    return out as ReadonlyMap<string, ReadonlySet<'in' | 'out'>>;
  });

  // ---- the pointer, and ＋ ------------------------------------------------------------------------
  const { hovered, hover, holdHover, clearHover, tooltip, focusOfHover: hoverOnly, socketHighlight, card } = useMapHover({ graph, nodeById, nodes, info });
  // A card lights up its chain: upstream, downstream or both, the way the right-click menu last said (both
  // when the map opens). The hovered card while the pointer is on one, else the selected card, so hover and
  // selection always agree. Hovering a wire or socket adds its wires to the selection's chain; hovering a
  // record in an Inside tray keeps the neighbour rule (useMapHover).
  const chainDir = ref<ChainDir>('both');
  const setChainDir = (d: ChainDir) => void (chainDir.value = d);
  const chain = computed(() => (graph.value ? chainFocus(graph.value, selectedId.value, chainDir.value) : null));
  const focusOfHover = computed<HoverFocus | null>(() => {
    const h = hoverOnly.value;
    const id = hovered.value?.id;
    if (graph.value && id && nodeById.value.has(id)) return chainFocus(graph.value, id, chainDir.value) ?? h;
    const c = chain.value;
    if (!c || (h && h.dim)) return h ?? c;
    return h ? { ...c, wires: new Set([...c.wires, ...h.wires]) } : c;
  });
  const expansion = useMapExpand({ api, gate, status, data, defs, graph, nodeById, shown, hiddenKinds, revealedKeys, graphOf, notice, capped, expanding });

  /** "Reset": the map as the focus first loaded it, without asking the server again; what ＋, Unstack and the folds did is gone. */
  function reset(): void {
    if (status.value !== 'ready') return;
    const first = expansion.restore(gate.begin()); // an expand still loading belongs to the map before the reset
    if (!first) return;
    generation.value++; // the canvas lays it out afresh
    revealedKeys.value = new Set();
    unfoldedKeys.value = new Set();
    moreOpenKeys.value = new Set();
    unstackedGroups.value = [];
    capped.value = false;
    notice.value = '';
    clearHover();
    data.value = first;
  }

  // Last, so that everything a load resets is there: it runs at once for a focus already in the address. A blank canvas turns
  // into the search-first page when edit mode ends, and back: a different state of the same (missing) focus.
  watch(
    () => `${focusKey.value}|${overlay?.blank() ? 'blank' : ''}`,
    () => void load(),
    { immediate: true },
  );

  /** True when the sample is part of what the map loaded (a draft can also hold samples picked from the index, which are not). */
  const inHistory = (id: string): boolean => !!data.value?.samples.some((x) => x.id === id);

  return {
    status,
    error,
    generation,
    /** What was loaded for the focus (the record the map is of): null on a blank canvas. */
    data,
    /** What is drawn: `data` with the draft merged in (edit mode), else `data` itself. The one place the overlay enters; the graph is built from it. */
    overlaid: shownData,
    graph,
    shown,
    nodes,
    focus,
    focusNodeId,
    reach,
    effectiveReach,
    partial,
    setReach,
    clearFocus,
    setFocus,
    pickRecord,
    dir,
    setDir,
    probable,
    setProbable,
    stack,
    setStack,
    unstack,
    restack,
    collapse: expansion.collapse,
    expandedIds: expansion.expandedIds,
    reset,
    hiddenKinds,
    toggleKind,
    presentKinds,
    project,
    expand: expansion.expand,
    notice,
    expanding,
    takeMergeHints: expansion.takeMergeHints,
    hintMerge: expansion.hint,
    toggleRows,
    toggleMore,
    moreOpen,
    select,
    selectedId,
    selected,
    selectedRefKey,
    centreRequest,
    hover,
    holdHover,
    clearHover,
    hovered,
    tooltip,
    info,
    selectedInfo,
    connections,
    selectedOnMap,
    focusOfHover,
    chainDir,
    setChainDir,
    socketHighlight,
    hiddenSides,
    card,
    reload: load,
    inHistory,
  };
}
