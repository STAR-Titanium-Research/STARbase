// The Process map's state: the focus (from the URL), the loaded family, the graph built from it, what is
// shown (reach, Show chips, expanded cards), what is selected and what the pointer is over. The page
// (ProcessMapPage.vue) draws it; the rail / hover card (Task 8) read `selected`, `hovered`, `tooltip`.
// Through the host's `api` only, like the model (spec §7).

import { computed, getCurrentInstance, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { errorText, isNotVisible, useRequestGate, type HostApi } from '@d1/ui';
import { buildGraph, fanRootId, moreNodeId } from './model/buildGraph';
import { connectionsOf, type Connections } from './model/connections';
import { FALLBACK_RELATIONS, formSlots, type RelationDef } from './model/formSlots';
import { groupBatches } from './model/groupBatches';
import { hoverFocus, socketSubjects, type HoverFocus } from './model/hoverFocus';
import { createHoverStack, type Hovered } from './model/hoverStack';
import { fanData, fanKindOf, fanNodeIds, fanPage, fanRowIds, focusPlan, hasFan, mergeProcessData, withFanPage, withSideFan } from './model/fans';
import { loadFamily, loadRecordRef, loadRelationDefs, loadStepRow, loadUsedIn, parseFocus, sampleOfRow } from './model/loadFamily';
import { shownNodes } from './model/reach';
import { recordInfo, type RecordInfo } from './model/recordInfo';
import type { ContainerNode, MapNode, ProcessData, ProcessGraph, Ref } from './model/types';
import { KINDS, kindOfCollection } from './nodes/kinds';
import { refKey } from './nodes/actions';
import { socketTooltip } from './nodes/wireTooltip';
import type { Dir } from './model/elkInput';

export type MapStatus = 'empty' | 'loading' | 'ready' | 'notVisible' | 'error';
export type Reach = 1 | 2 | 3 | 'all';

const DEFAULT_REACH: Reach = 2;
/** How long the pointer rests on a card before its hover card opens (spec 6.6). */
export const HOVER_DELAY_MS = 250;
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

/** What the canvas is told when an expand (not a new focus) changes what is drawn: where the new cards go (spec §6.7). */
export interface MergeHint {
  /** The card the person expanded: new cards line up with it, or sit beside it when nothing placed is wired to them. */
  anchor?: string;
  /** The collapsed container `anchor` replaced (it has another id when it joined a batch): `anchor` takes its place and size. */
  from?: string;
  /** Cards to lay out again from ELK's result (a "+N more" stub moves to the end of its column). */
  replace?: string[];
}

/** A focused operation or test that has no sample to open the family of. */
class NoSample extends Error {}

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
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      gate.cancel();
      if (cardTimer) clearTimeout(cardTimer);
    });
  }

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
    if (!data.value?.fan) {
      revealed.value = new Set();
      capped.value = false;
    }
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
  /** The last expand could not add everything: the 300-card cap (spec D22) stopped it. */
  const capped = ref(false);
  /** Counts focus loads: the canvas starts afresh on a new one, not on an expand (which changes `data` too). */
  const generation = ref(0);
  /** What the last expand said, when it could not do what was asked (an error keeps what is loaded, spec §7). */
  const notice = ref('');
  /** Expands in flight. */
  const expanding = ref(0);
  const centreRequest = shallowRef<{ id: string; n: number } | null>(null);

  const hoverStack = createHoverStack();
  const hovered = shallowRef<Hovered | null>(null);
  const hover = (id: string | null, el?: HTMLElement) => void (hovered.value = hoverStack.hover(id, el));
  const clearHover = () => void (hovered.value = hoverStack.clear());

  /** The load (focus) the loaded data belongs to: the result of an expand that outlives its focus is dropped. */
  let loadToken = 0;
  /** Samples whose whole family is loaded; a sample card outside them opens by loading its family. */
  let familyLoaded = new Set<string>();
  /** Pages read of each fan (`<collection>:<id>`), for "+N more". */
  let fanPages = new Map<string, number>();
  /** What the next layout is told about the change that triggered it: an expand, not a new focus. */
  let mergeHint: MergeHint | null = null;
  /**
   * Tells the next layout what kind of change it is for; forgotten once Vue has applied the change. Called
   * after the change is made, so `nextTick` waits for the flush that carries it.
   */
  const hint = (h: MergeHint): void => {
    mergeHint = h;
    void nextTick().then(() => void (mergeHint = null));
  };
  const publish = (d: ProcessData, h: MergeHint): void => {
    data.value = d;
    hint(h);
  };
  /** Taken by the canvas when it lays out after an expand: where the new cards go (spec §6.7). */
  const takeMergeHint = (): MergeHint | null => {
    const h = mergeHint;
    mergeHint = null;
    return h;
  };

  /** What opening on a record loads (spec D20). */
  async function loadFocus(f: { collection: string; id: string }, plan: 'sample' | 'step' | 'fan'): Promise<{ data: ProcessData; defs: DefsByKind }> {
    if (plan === 'sample') {
      const [family, relationDefs] = await Promise.all([loadFamily(api, f.id), loadDefs(api)]);
      return { data: family, defs: relationDefs };
    }
    if (plan === 'step') {
      // The family of the step's sample, with the step's own container focused.
      const row = await loadStepRow(api, f);
      const kind = f.collection === 'test_sessions' ? 'test' : 'operation';
      const sampleId = sampleOfRow(row);
      if (!sampleId) throw new NoSample(`This ${kind} has no sample, so there is no process to show.`);
      const [family, relationDefs] = await Promise.all([loadFamily(api, sampleId), loadDefs(api)]);
      const inFamily = kind === 'test' ? family.tests.some((t) => t.id === row.id) : family.operations.some((o) => o.id === row.id);
      if (!inFamily) return { data: family, defs: relationDefs };
      return { data: { ...family, focus: { collection: f.collection, id: row.id, code: row.code, kind } }, defs: relationDefs };
    }
    const [record, used, relationDefs] = await Promise.all([loadRecordRef(api, f), loadUsedIn(api, f, 1), loadDefs(api)]);
    return { data: fanData({ ...record, kind: fanKindOf(f.collection) }, fanPage(f.collection, used, 1)), defs: relationDefs };
  }

  async function load(): Promise<void> {
    const token = gate.begin();
    loadToken = token;
    generation.value++;
    data.value = null;
    unfolded.value = new Set();
    moreOpen.value = new Set();
    revealed.value = new Set();
    capped.value = false;
    notice.value = '';
    familyLoaded = new Set();
    fanPages = new Map();
    selectedId.value = null;
    clearHover();
    error.value = '';
    const f = focus.value;
    if (!f) {
      status.value = 'empty';
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
      const loaded = await loadFocus(f, plan);
      if (!gate.isCurrent(token)) return;
      defs.value = loaded.defs;
      data.value = loaded.data;
      if (plan === 'fan') fanPages.set(`${f.collection}:${f.id}`, 1);
      else familyLoaded = new Set(loaded.data.samples.map((s) => s.id));
      selectedId.value = focusNodeId.value || null;
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
  watch(focusKey, () => void load(), { immediate: true });

  // ---- the graph ----------------------------------------------------------------------------------
  /** The graph of `d`. Steps still collapsed in a fan are drawn by buildGraph's fan mode, not grouped into batches. */
  function graphOf(d: ProcessData): ProcessGraph {
    const collapsed = fanRowIds(d);
    const groups = groupBatches(
      d.operations.filter((o) => !collapsed.has(o.id)),
      d.tests.filter((t) => !collapsed.has(t.id)),
      { probable: probable.value },
    );
    return buildGraph(d, groups, { slots: (row, kind) => formSlots(row, kind, defs.value[kind]), unfolded: unfolded.value });
  }
  const graph = computed<ProcessGraph | null>(() => (data.value ? graphOf(data.value) : null));
  // A rebuilt graph removes elements that never see mouseleave.
  watch(graph, () => clearHover());

  const focusProjectId = computed(() => {
    const d = data.value;
    if (!d) return null;
    const { kind, id } = d.focus;
    if (kind === 'sample') return d.samples.find((s) => s.id === id)?.projectId ?? null;
    if (kind === 'operation') return d.operations.find((o) => o.id === id)?.projectId ?? null;
    if (kind === 'test') return d.tests.find((t) => t.id === id)?.projectId ?? null;
    return kind === 'project' ? id : null;
  });
  /** The node the map is focused on: the sample's card, the step's container (in whichever batch it is), the record a fan hangs from. */
  const focusNodeId = computed(() => {
    const d = data.value;
    const g = graph.value;
    if (!d || !g) return '';
    const { kind, id } = d.focus;
    if (kind === 'sample') return `s:${id}`;
    if (kind === 'operation' || kind === 'test') return g.nodes.find((n) => n.type === 'container' && n.kind === kind && n.group.rowIds.includes(id))?.id ?? '';
    return fanRootId(d.focus);
  });

  const fitted = computed(() => {
    const g = graph.value;
    const d = data.value;
    if (!g || !d || !focusNodeId.value) return { ids: new Set<string>(), effective: reach.value, clamped: false };
    // What a fan lists is always drawn. A fan has no reach (it has no steps to count), so only fans are shown.
    const fans = fanNodeIds(d, g);
    if (d.fan) return { ids: fans, effective: reach.value, clamped: false };
    const r = fitReach(g, focusNodeId.value, reach.value);
    return fans.size ? { ...r, ids: new Set([...r.ids, ...fans]) } : r;
  });
  const effectiveReach = computed(() => fitted.value.effective);
  /** The banner "Showing part of this history" (spec D22). */
  const partial = computed(() => !!data.value?.truncated || fitted.value.clamped || capped.value);

  const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map((n) => [n.id, n])));

  /** The cards a Show chip never hides: the focus, and the record each fan hangs from (a remembered "Tool" chip must not empty a tool's fan). */
  const pinned = computed(() => {
    const d = data.value;
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

  // ---- ＋ (spec D15, §7 "Expand") ---------------------------------------------------------------
  /** Adds ids to what is drawn, up to the 300-card cap (spec D22): when some do not fit, the banner says so. */
  function admit(ids: Iterable<string>, force: Iterable<string> = []): void {
    // Cards that were on the map before the expand (the fan items a merged family now holds in full) stay whatever the cap says.
    const kept = [...force].filter((id) => nodeById.value.has(id) && !shown.value.has(id));
    if (kept.length) revealed.value = new Set([...revealed.value, ...kept]);
    const add: string[] = [];
    for (const id of ids) {
      const n = nodeById.value.get(id);
      if (!n || shown.value.has(id) || (n.type === 'record' && hiddenKinds.value.has(n.kind))) continue;
      add.push(id);
    }
    const room = Math.max(0, CARD_CAP - shown.value.size);
    if (add.length > room) capped.value = true;
    if (room && add.length) revealed.value = new Set([...revealed.value, ...add.slice(0, room)]);
  }

  /** The record inside a card (an Inside slot) that an action id (`<collection>:<id>`) names, and the container holding it. */
  function slotRecord(id: string): { ref: Ref; owner: string } | null {
    for (const c of graph.value?.nodes ?? []) {
      if (c.type !== 'container') continue;
      for (const s of c.slots) {
        const hit = (s.ref ? [s.ref] : (s.values ?? [])).find((r) => refKey(r) === id);
        if (hit) return { ref: hit, owner: c.id };
      }
    }
    return null;
  }

  /** The fans on the map by their record (`<collection>:<id>`). */
  const fanRoots = (d: ProcessData): Set<string> =>
    new Set([...(d.fan ? [`${d.focus.collection}:${d.focus.id}`] : []), ...(d.sideFans ?? []).map((f) => `${f.root.collection}:${f.root.id}`)]);

  /** Runs one expand: counts it while it loads, and says what went wrong without dropping what is loaded (spec §7). */
  async function withBusy<T>(work: () => Promise<T>): Promise<T | undefined> {
    expanding.value++;
    try {
      return await work();
    } catch (e) {
      notice.value = `Could not load more of the Process map: ${errorText(e)}`;
      return undefined;
    } finally {
      expanding.value--;
    }
  }

  /** The family of a sample merged into the map; the card that was expanded keeps its place (spec §6.7). */
  function openFamily(sampleId: string, opts: { node?: string; rowId?: string; from?: string }): Promise<void> {
    const mine = loadToken;
    return withBusy(async () => {
      const [family, relationDefs] = await Promise.all([loadFamily(api, sampleId), loadDefs(api)]);
      const before = data.value;
      if (!gate.isCurrent(mine) || !before) return;
      const merged = mergeProcessData(before, family);
      if (opts.rowId && fanRowIds(merged).has(opts.rowId)) {
        notice.value = 'The samples of this step cannot be read, so its flow is not shown.';
        return;
      }
      defs.value = relationDefs;
      const next = graphOf(merged);
      const anchor = opts.rowId ? next.nodes.find((n) => n.type === 'container' && n.group.rowIds.includes(opts.rowId!))?.id : opts.node;
      for (const s of family.samples) familyLoaded.add(s.id);
      // Fan items the family now holds in full (other passes of the same tool on this sample) were cards on the map: they stay.
      const opened = new Set([...fanRowIds(before)].filter((id) => !fanRowIds(merged).has(id)));
      const stay = next.nodes.filter((n) => n.type === 'container' && n.group.rowIds.some((id) => opened.has(id))).map((n) => n.id);
      publish(merged, { anchor, from: opts.from });
      admit(anchor ? shownNodes(next, anchor, 1) : [], anchor ? [anchor, ...stay] : stay);
    }) as Promise<void>;
  }

  /** The fan of a record inside the map merged beside it ("used in"). */
  function openSideFan(ref: Ref, anchor: string): Promise<void> {
    const mine = loadToken;
    return withBusy(async () => {
      const used = await loadUsedIn(api, ref, 1);
      const before = data.value;
      if (!gate.isCurrent(mine) || !before) return;
      const page = fanPage(ref.collection, used, 1);
      const held = new Set([...before.operations.map((o) => o.id), ...before.tests.map((t) => t.id)]);
      const fresh = page.items.filter((i) => i.collection === 'physical_samples' || !held.has(i.id)).length;
      if (!fresh && !page.remaining) {
        notice.value = `Nothing else in the map used ${ref.code}.`;
        return;
      }
      if (shown.value.size + fresh + 2 > CARD_CAP) {
        capped.value = true;
        return;
      }
      fanPages.set(`${ref.collection}:${ref.id}`, 1);
      publish(withSideFan(before, { ...ref, kind: fanKindOf(ref.collection) }, page), { anchor });
    }) as Promise<void>;
  }

  const paging = new Set<string>();
  /** "+N more": the next page of a fan. */
  function loadMore(key: string): Promise<void> {
    const at = key.indexOf(':');
    const collection = key.slice(0, at);
    const id = key.slice(at + 1);
    const mine = loadToken;
    if (paging.has(key)) return Promise.resolve();
    paging.add(key);
    return (withBusy(async () => {
      const next = (fanPages.get(key) ?? 1) + 1;
      const used = await loadUsedIn(api, { collection, id }, next);
      const before = data.value;
      if (!gate.isCurrent(mine) || !before) return;
      const page = fanPage(collection, used, next);
      const held = new Set([...before.operations.map((o) => o.id), ...before.tests.map((t) => t.id)]);
      const fresh = page.items.filter((i) => i.collection === 'physical_samples' || !held.has(i.id)).length;
      if (shown.value.size + fresh > CARD_CAP) {
        capped.value = true; // stop adding; what is drawn stays, and the stub stays to say there is more
        return;
      }
      fanPages.set(key, next);
      // The stub moves to the end of the longer column.
      publish(withFanPage(before, key, page), { replace: [moreNodeId({ collection, id })] });
    }) as Promise<void>).finally(() => void paging.delete(key));
  }

  /**
   * ＋ on a card or a record in an Inside tray: loads what is not there yet, and shows what is one process step beyond it.
   * A collapsed container opens its sample's family; a sample outside the loaded families, its family; a record with a
   * used-in fan (a tool in an Inside tray, a material or stock lot card), its fan beside it; "+N more", the next page.
   */
  async function expand(id: string): Promise<void> {
    const d = data.value;
    const g = graph.value;
    if (!d || !g || status.value !== 'ready') return;
    notice.value = '';
    if (id.startsWith('more:')) return loadMore(id.slice('more:'.length));
    const node = nodeById.value.get(id);
    if (node?.type === 'container' && node.collapsed) {
      const rowId = node.group.rowIds[0];
      const row = node.kind === 'operation' ? d.operations.find((o) => o.id === rowId) : d.tests.find((t) => t.id === rowId);
      const sample = row ? sampleOfRow(row) : null;
      if (!sample) {
        notice.value = `${node.title} has no sample to open.`;
        return;
      }
      return openFamily(sample, { rowId, from: id });
    }
    if (node?.type === 'record' && node.kind === 'sample' && !familyLoaded.has(node.ref.id)) return openFamily(node.ref.id, { node: id });
    if (node?.type === 'record' && node.kind !== 'sample' && hasFan(node.ref.collection)) {
      const key = refKey(node.ref);
      if (!fanRoots(d).has(key)) return openSideFan(node.ref, id);
      const remaining = d.fan && key === `${d.focus.collection}:${d.focus.id}` ? (d.fan.remaining ?? 0) : ((d.sideFans ?? []).find((f) => refKey(f.root) === key)?.remaining ?? 0);
      if (remaining > 0) return loadMore(key);
    }
    if (!node) {
      const slot = slotRecord(id);
      if (slot && hasFan(slot.ref.collection)) {
        if (!fanRoots(d).has(refKey(slot.ref))) return openSideFan(slot.ref, slot.owner);
        notice.value = `${slot.ref.code} is already open on the map.`;
      }
      return;
    }
    admit(shownNodes(g, id, 1));
    hint({ anchor: id });
  }

  const flip = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const toggleRows = (id: string) => void (unfolded.value = flip(unfolded.value, id));
  const toggleMore = (id: string) => void (moreOpen.value = flip(moreOpen.value, id));

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
    if (!nodeById.value.has(h.id) && /:(?:in|out):[^:]+$/.test(h.id)) {
      const drawn = new Map(nodes.value.map((n) => [n.id, n]));
      return { id: h.id, lines: socketTooltip(h.id, g.wires, drawn), el: h.el, wire: false };
    }
    return null;
  });

  // ---- what the rail and the hover card say --------------------------------------------------------
  /** What a record (a node id, or a record inside a card) is: facts, counts, data to ask about. Null when the map does not know it. */
  const info = (id: string): RecordInfo | null => (data.value && graph.value ? recordInfo(data.value, graph.value, id) : null);
  const selectedInfo = computed(() => (selectedId.value ? info(selectedId.value) : null));
  /** The selected record's connections, grouped for the rail. */
  const connections = computed<Connections>(() => (graph.value && selectedId.value ? connectionsOf(graph.value, selectedId.value) : {}));
  /** Is the selected record a card on the map (Expand and Centre act on cards). */
  const selectedOnMap = computed(() => !!selectedId.value && shown.value.has(selectedId.value));

  /** What the pointer's target lights up: its wires, and everything else dimmed (spec §6.3). */
  const focusOfHover = computed<HoverFocus | null>(() => (graph.value ? hoverFocus(graph.value, hovered.value?.id ?? null) : null));

  /** While a socket is hovered: the node ids its wires touch, which the rail's Connections highlight (spec D17). */
  const socketHighlight = computed<ReadonlySet<string>>(() => {
    const id = hovered.value?.id;
    const g = graph.value;
    return id && g && !nodeById.value.has(id) && /:(?:in|out):[^:]+$/.test(id) ? socketSubjects(g, id) : new Set<string>();
  });

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

  /** The hover card (spec D16): the hovered card or slot, once the pointer has rested on it for 250 ms. */
  const card = shallowRef<{ id: string; el: HTMLElement; info: RecordInfo } | null>(null);
  watch(hovered, (h) => {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = null;
    card.value = null;
    if (!h?.el) return;
    const resting = h;
    cardTimer = setTimeout(() => {
      cardTimer = null;
      const now = hovered.value;
      const found = now && now.id === resting.id && now.el ? info(now.id) : null;
      if (found && now?.el) card.value = { id: now.id, el: now.el, info: found };
    }, HOVER_DELAY_MS);
  });

  return {
    status,
    error,
    generation,
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
    notice,
    expanding,
    takeMergeHint,
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
    info,
    selectedInfo,
    connections,
    selectedOnMap,
    focusOfHover,
    socketHighlight,
    hiddenSides,
    card,
    reload: load,
  };
}

