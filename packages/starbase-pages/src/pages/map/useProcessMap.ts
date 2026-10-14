// The Process map's state: the focus (from the URL), the loaded family, the graph built from it, what is
// shown (reach, Show chips, expanded cards), what is selected and what the pointer is over. The page
// (ProcessMapPage.vue) draws it; the rail / hover card (Task 8) read `selected`, `hovered`, `tooltip`.
// Through the host's `api` only, like the model (spec §7).

import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { errorText, isNotVisible, useRequestGate, type HostApi } from '@d1/ui';
import { buildGraph } from './model/buildGraph';
import { FALLBACK_RELATIONS, formSlots, type RelationDef } from './model/formSlots';
import { groupBatches } from './model/groupBatches';
import { createHoverStack, type Hovered } from './model/hoverStack';
import { loadFamily, loadRelationDefs, parseFocus } from './model/loadFamily';
import { shownNodes } from './model/reach';
import type { ContainerNode, MapNode, ProcessData, ProcessGraph, Ref } from './model/types';
import { KINDS, kindOfCollection } from './nodes/kinds';
import { refKey } from './nodes/actions';
import type { Dir } from './model/elkInput';

export type MapStatus = 'empty' | 'loading' | 'ready' | 'notVisible' | 'error';
export type Reach = 1 | 2 | 3 | 'all';

const DEFAULT_REACH: Reach = 2;
/** Soft cap on the cards the map draws (spec D22). */
export const CARD_CAP = 300;
/** localStorage key of the Show chips (spec D25). */
export const SHOW_KEY = 'd1.map.show.v1';
/** The Show chip that hides key settings: not a kind, kept in the same set. */
export const SETTINGS_CHIP = 'settings';
/** Cards that are only ever drawn beside what they feed; a Show chip each. */
const SOURCE_KINDS = ['stock_lot', 'powder_batch', 'material'];
/** What a Show chip may hide: never the samples, operations, tests or lineage the wires run through. */
const STRUCTURAL = new Set(['sample', 'operation', 'test', 'junction']);
const HIDEABLE: ReadonlySet<string> = new Set([...Object.keys(KINDS).filter((k) => !STRUCTURAL.has(k)), SETTINGS_CHIP]);

/** The route and router the map needs: kept to what it uses so tests can fake them. */
export interface MapRoute {
  path: string;
  query: Record<string, unknown>;
}
export interface MapRouter {
  replace(to: { path: string; query: Record<string, string> }): unknown;
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

// ---- remembered Show chips -------------------------------------------------------------------

interface Remembered {
  hidden: string[];
  probable: boolean;
}

/** localStorage can be missing (node), blocked or full: every access is guarded and falls back to the defaults. */
function readRemembered(): Remembered {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOW_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      return {
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((k: unknown): k is string => typeof k === 'string' && HIDEABLE.has(k)) : [],
        probable: parsed.probable !== false,
      };
    }
  } catch {
    /* no storage: defaults */
  }
  return { hidden: [], probable: true };
}

function writeRemembered(r: Remembered): void {
  try {
    localStorage.setItem(SHOW_KEY, JSON.stringify(r));
  } catch {
    /* not remembered; the chips still work for this visit */
  }
}

// ---- relation defs of the two forms, cached per api ------------------------------------------

type DefsByKind = { operation: RelationDef[]; test: RelationDef[] };
const defsCache = new WeakMap<HostApi, Promise<DefsByKind>>();

function loadDefs(api: HostApi): Promise<DefsByKind> {
  let cached = defsCache.get(api);
  if (!cached) {
    // A refused or failed read is not fatal: the known relations of each form stand in (spec §7 step 5).
    const read = (collection: string, kind: 'operation' | 'test') =>
      loadRelationDefs(api, collection)
        .catch(() => null)
        .then((defs) => defs ?? FALLBACK_RELATIONS[kind]);
    cached = Promise.all([read('manufacturing_operations', 'operation'), read('test_sessions', 'test')]).then(([operation, test]) => ({ operation, test }));
    defsCache.set(api, cached);
  }
  return cached;
}

// ---- reach ------------------------------------------------------------------------------------

/** The nodes shown at `reach`, stepped down 3, 2, 1 while more than CARD_CAP would show (spec D22). */
function fitReach(graph: ProcessGraph, focusNodeId: string, reach: Reach): { ids: Set<string>; effective: Reach; clamped: boolean } {
  let ids = shownNodes(graph, focusNodeId, reach);
  let effective = reach;
  if (ids.size <= CARD_CAP) return { ids, effective, clamped: false };
  for (const step of [3, 2, 1] as const) {
    if (reach !== 'all' && step >= reach) continue;
    effective = step;
    ids = shownNodes(graph, focusNodeId, step);
    if (ids.size <= CARD_CAP) break;
  }
  return { ids, effective, clamped: true };
}

/** Kind of a slot's record (the `--k-*` colour and the Show chip it belongs to), null when unknown. */
const slotKind = (collection: string): string | null => kindOfCollection(collection);

export function useProcessMap(api: HostApi, route: MapRoute, router: MapRouter) {
  const gate = useRequestGate();
  if (getCurrentInstance()) onBeforeUnmount(() => gate.cancel());

  // ---- the address (spec D25) -------------------------------------------------------------------
  const focus = computed(() => parseFocus(first(route.query.focus)) ?? (first(route.query.sample) ? { collection: 'physical_samples', id: first(route.query.sample)! } : null));
  const focusKey = computed(() => (focus.value ? `${focus.value.collection}:${focus.value.id}` : ''));
  const reach = ref<Reach>(parseReach(first(route.query.reach)));
  watch(
    () => first(route.query.reach),
    (v) => void (reach.value = parseReach(v)),
  );

  /** `router.replace` on the page's own path (so it holds in both hosts), keeping other query keys; `sample` becomes `focus`. */
  function writeUrl(patch: Record<string, string>): void {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      const s = first(v);
      if (s !== undefined && k !== 'sample') query[k] = s;
    }
    if (focusKey.value) query.focus = focusKey.value;
    void router.replace({ path: route.path, query: { ...query, ...patch } });
  }
  /** The Finder picked a record: load it into the map (reach kept). */
  function setFocus(collection: string, id: string): void {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      const s = first(v);
      if (s !== undefined && k !== 'sample') query[k] = s;
    }
    void router.replace({ path: route.path, query: { ...query, focus: `${collection}:${id}`, reach: String(reach.value) } });
  }
  /** "Clear": back to the search-first page, keeping the other query keys. */
  function clearFocus(): void {
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(route.query)) {
      const s = first(v);
      if (s !== undefined && k !== 'sample' && k !== 'focus') query[k] = s;
    }
    void router.replace({ path: route.path, query });
  }
  function setReach(r: Reach): void {
    reach.value = r;
    revealed.value = new Set();
    writeUrl({ reach: String(r) });
  }

  // ---- Show chips (spec D14, D25) ---------------------------------------------------------------
  const remembered = readRemembered();
  const hiddenKinds = ref<ReadonlySet<string>>(new Set(remembered.hidden));
  const probable = ref(remembered.probable);
  const remember = () => writeRemembered({ hidden: [...hiddenKinds.value], probable: probable.value });
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

  // ---- what the page asks for ---------------------------------------------------------------------
  const dir = ref<Dir>('RIGHT');
  const setDir = (d: Dir) => void (dir.value = d);

  const status = ref<MapStatus>('empty');
  const error = ref('');
  const data = shallowRef<ProcessData | null>(null);
  const defs = shallowRef<DefsByKind>({ operation: FALLBACK_RELATIONS.operation, test: FALLBACK_RELATIONS.test });
  const unfolded = ref<ReadonlySet<string>>(new Set());
  const moreOpen = ref<ReadonlySet<string>>(new Set());
  /** Cards the person revealed with ＋ beyond what the reach shows. */
  const revealed = ref<ReadonlySet<string>>(new Set());
  const selectedId = ref<string | null>(null);
  const centreRequest = shallowRef<{ id: string; n: number } | null>(null);

  const hoverStack = createHoverStack();
  const hovered = shallowRef<Hovered | null>(null);
  const hover = (id: string | null, el?: HTMLElement) => void (hovered.value = hoverStack.hover(id, el));
  const clearHover = () => void (hovered.value = hoverStack.clear());

  async function load(): Promise<void> {
    const token = gate.begin();
    data.value = null;
    unfolded.value = new Set();
    moreOpen.value = new Set();
    revealed.value = new Set();
    selectedId.value = null;
    clearHover();
    error.value = '';
    const f = focus.value;
    if (!f) {
      status.value = 'empty';
      return;
    }
    if (f.collection !== 'physical_samples') {
      // Opening on a tool, machine, project... is the used-in fan (spec D20), not built yet.
      status.value = 'error';
      error.value = 'The Process map opens on a sample for now. Open a sample and use its Process map button.';
      return;
    }
    status.value = 'loading';
    try {
      const [family, relationDefs] = await Promise.all([loadFamily(api, f.id), loadDefs(api)]);
      if (!gate.isCurrent(token)) return;
      defs.value = relationDefs;
      data.value = family;
      selectedId.value = `s:${family.focus.id}`;
      status.value = 'ready';
    } catch (e) {
      if (!gate.isCurrent(token)) return;
      if (isNotVisible(e)) status.value = 'notVisible';
      else {
        status.value = 'error';
        error.value = `Could not load the Process map: ${errorText(e)}`;
      }
    }
  }
  watch(focusKey, () => void load(), { immediate: true });

  // ---- the graph ----------------------------------------------------------------------------------
  const graph = computed<ProcessGraph | null>(() => {
    const d = data.value;
    if (!d) return null;
    const groups = groupBatches(d.operations, d.tests, { probable: probable.value });
    return buildGraph(d, groups, { slots: (row, kind) => formSlots(row, kind, defs.value[kind]), unfolded: unfolded.value });
  });
  // A rebuilt graph removes elements that never see mouseleave.
  watch(graph, () => clearHover());

  const focusProjectId = computed(() => {
    const d = data.value;
    return d?.samples.find((s) => s.id === d.focus.id)?.projectId ?? null;
  });
  const focusNodeId = computed(() => (data.value ? `s:${data.value.focus.id}` : ''));

  const fitted = computed(() => {
    const g = graph.value;
    if (!g || !focusNodeId.value) return { ids: new Set<string>(), effective: reach.value, clamped: false };
    return fitReach(g, focusNodeId.value, reach.value);
  });
  const effectiveReach = computed(() => fitted.value.effective);
  /** The banner "Showing part of this history" (spec D22). */
  const partial = computed(() => !!data.value?.truncated || fitted.value.clamped);

  const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map((n) => [n.id, n])));

  /** Node ids drawn: the reach, plus what ＋ revealed, minus the hidden Show chips. */
  const shown = computed(() => {
    const ids = new Set([...fitted.value.ids, ...revealed.value]);
    for (const id of ids) {
      const n = nodeById.value.get(id);
      if (n?.type === 'record' && hiddenKinds.value.has(n.kind)) ids.delete(id);
    }
    return ids;
  });

  /** The shown nodes with the Show chips applied to their Inside slots and key settings, and other projects tagged. */
  const nodes = computed<MapNode[]>(() => {
    const hide = hiddenKinds.value;
    const home = focusProjectId.value;
    return (graph.value?.nodes ?? [])
      .filter((n) => shown.value.has(n.id))
      .map((n) => {
        // Spec D13: a record of another project says so on its meta line.
        if (n.type === 'record' && home && n.projectId && n.projectId !== home) return { ...n, meta: [n.meta, 'other project'].filter(Boolean).join(' · ') };
        if (n.type !== 'container') return n;
        const slots = n.slots.filter((s) => {
          const refs = s.ref ? [s.ref] : (s.values ?? []);
          const kind = refs[0] ? slotKind(refs[0].collection) : null;
          return !(kind && hide.has(kind));
        });
        const settings = hide.has(SETTINGS_CHIP) ? [] : n.settings;
        return slots.length === n.slots.length && settings === n.settings ? n : ({ ...n, slots, settings } satisfies ContainerNode);
      });
  });

  /** The kinds a Show chip can hide here: source cards and Inside slot kinds present, and the settings chip. */
  const presentKinds = computed(() => {
    const kinds = new Set<string>();
    for (const n of graph.value?.nodes ?? []) {
      if (n.type === 'record' && SOURCE_KINDS.includes(n.kind)) kinds.add(n.kind);
      if (n.type === 'container') {
        for (const s of n.slots) {
          const r = s.ref ?? s.values?.[0];
          const k = r ? slotKind(r.collection) : null;
          if (k) kinds.add(k);
        }
        if (n.settings.length) kinds.add(SETTINGS_CHIP);
      }
    }
    return [...kinds];
  });

  // ---- project frame (spec D13) -----------------------------------------------------------------
  /** The focus sample's project, named by an operation or test that carries it; null when no row does. */
  const project = computed(() => {
    const d = data.value;
    const id = focusProjectId.value;
    if (!d || !id) return null;
    for (const row of [...d.operations, ...d.tests]) {
      const r = row.relations.project_id;
      if (r && r.id === id) return r;
    }
    return { collection: 'projects', id, code: '' } satisfies Ref;
  });

  // ---- selection ----------------------------------------------------------------------------------
  /** The record behind an id of the actions: a node id, or a slot's `<collection>:<id>`. */
  function recordOf(id: string): Selected | null {
    const d = data.value;
    const n = nodeById.value.get(id);
    if (n?.type === 'record') return { ref: n.ref, kind: n.kind };
    if (n?.type === 'container' && d) {
      const rowId = n.rows[0]?.recordId ?? n.group.rowIds[0];
      const row = n.kind === 'operation' ? d.operations.find((o) => o.id === rowId) : d.tests.find((t) => t.id === rowId);
      if (!row) return null;
      return { ref: { collection: n.kind === 'operation' ? 'manufacturing_operations' : 'test_sessions', id: row.id, code: row.code }, kind: n.kind };
    }
    if (n?.type === 'junction') return recordOf(`s:${n.parentId}`);
    for (const c of graph.value?.nodes ?? []) {
      if (c.type !== 'container') continue;
      for (const s of c.slots) {
        for (const r of s.ref ? [s.ref] : (s.values ?? [])) {
          if (refKey(r) === id) return { ref: r, kind: slotKind(r.collection) ?? 'data_file' };
        }
      }
    }
    return null;
  }
  const selected = computed(() => (selectedId.value ? recordOf(selectedId.value) : null));
  const selectedRefKey = computed(() => (selected.value ? refKey(selected.value.ref) : null));

  let centreCount = 0;
  function select(id: string, opts: { centre?: boolean } = {}): void {
    selectedId.value = id;
    if (opts.centre) centreRequest.value = { id, n: ++centreCount };
  }

  /** ＋ on a card: what is one process step beyond it becomes shown. (Loading more of the history is Task 9.) */
  function expand(id: string): void {
    const g = graph.value;
    if (!g || !nodeById.value.has(id)) return;
    revealed.value = new Set([...revealed.value, ...shownNodes(g, id, 1)]);
  }

  const flip = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const toggleRows = (id: string) => void (unfolded.value = flip(unfolded.value, id));
  const toggleMore = (id: string) => void (moreOpen.value = flip(moreOpen.value, id));

  /** The hover tooltip of a wire (spec D17): its lines are on the hovered hit path as `data-tip`. */
  const tooltip = computed(() => {
    const h = hovered.value;
    if (!h || !graph.value?.wires.some((w) => w.id === h.id)) return null;
    const tip = h.el?.dataset?.tip;
    return tip ? { id: h.id, lines: tip.split('\n'), el: h.el } : null;
  });

  return {
    status,
    error,
    data,
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
    dir,
    setDir,
    probable,
    setProbable,
    hiddenKinds,
    toggleKind,
    presentKinds,
    project,
    expand,
    toggleRows,
    toggleMore,
    moreOpen,
    select,
    selectedId,
    selected,
    selectedRefKey,
    centreRequest,
    hover,
    clearHover,
    hovered,
    tooltip,
    reload: load,
  };
}

