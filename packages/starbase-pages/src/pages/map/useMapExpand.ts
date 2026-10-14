// Plus on the Process map (spec D15, §7 "Expand"): loading what is not there yet and showing what is one step beyond
// a card. A collapsed container opens its sample's family; a sample outside the loaded families, its family; a
// record with a used-in fan, its fan beside it; "+N more", the next page. Also what the next layout is told about
// such a change (spec §6.7). Split off `useProcessMap`, which owns the state this changes and hands it in.

import { nextTick, type ComputedRef, type Ref as VueRef, type ShallowRef } from 'vue';
import { errorText, type HostApi, type useRequestGate } from '@d1/ui';
import { moreNodeId } from './model/buildGraph';
import { COLLECTION, fanKindOf, hasFan } from './model/collections';
import { fanPage, fanRowIds, mergeProcessData, withFanPage, withSideFan } from './model/fans';
import { loadUsedIn, sampleOfRow } from './model/loadFans';
import { loadFamilyAndDefs, type DefsByKind } from './model/loadFocus';
import { CARD_CAP, shownNodes } from './model/reach';
import type { MapNode, MapStatus, ProcessData, ProcessGraph, Ref } from './model/types';
import { stableKeys } from './model/viewState';
import { refKey } from './nodes/actions';

/** What the canvas is told when an expand (not a new focus) changes what is drawn: where the new cards go (spec §6.7). */
export interface MergeHint {
  /** The card the person expanded: new cards line up with it, or sit beside it when nothing placed is wired to them. */
  anchor?: string;
  /** The collapsed container `anchor` replaced (it has another id when it joined a batch): `anchor` takes its place and size. */
  from?: string;
  /** Cards to lay out again from ELK's result (a "+N more" stub moves to the end of its column). */
  replace?: string[];
}

/** The state of `useProcessMap` an expand reads and changes. */
export interface ExpandDeps {
  api: HostApi;
  gate: ReturnType<typeof useRequestGate>;
  status: VueRef<MapStatus>;
  data: ShallowRef<ProcessData | null>;
  defs: ShallowRef<DefsByKind>;
  graph: ComputedRef<ProcessGraph | null>;
  /** Every node of the graph by id (drawn or not). */
  nodeById: ComputedRef<ReadonlyMap<string, MapNode>>;
  shown: ComputedRef<ReadonlySet<string>>;
  hiddenKinds: VueRef<ReadonlySet<string>>;
  revealedKeys: VueRef<ReadonlySet<string>>;
  /** The graph `d` would draw (batches grouped, cards unfolded as the person left them). */
  graphOf: (d: ProcessData) => ProcessGraph;
  notice: VueRef<string>;
  capped: VueRef<boolean>;
  /** Expands in flight. */
  expanding: VueRef<number>;
}

export function useMapExpand(deps: ExpandDeps) {
  const { api, gate, status, data, defs, graph, nodeById, shown, hiddenKinds, revealedKeys, graphOf, notice, capped, expanding } = deps;

  /** The load (focus) the loaded data belongs to: the result of an expand that outlives its focus is dropped. */
  let loadToken = 0;
  /** Samples whose whole family is loaded; a sample card outside them opens by loading its family. */
  let familyLoaded = new Set<string>();
  /** Pages read of each fan (`<collection>:<id>`), for "+N more". */
  let fanPages = new Map<string, number>();
  /** Expands in flight, by card (a second plus on it is ignored) and by fan (the next page). */
  const opening = new Set<string>();
  const paging = new Set<string>();

  /** A new focus is loading: everything an expand of the old one kept is forgotten. */
  function reset(token: number): void {
    loadToken = token;
    familyLoaded = new Set();
    fanPages = new Map();
    opening.clear(); // a key of the old focus must not swallow a click
    paging.clear();
  }
  /** The focus loaded: the samples whose family it holds, or the first page of its fan. */
  function loaded(what: { families: string[] } | { fan: string }): void {
    if ('families' in what) familyLoaded = new Set(what.families);
    else fanPages.set(what.fan, 1);
  }

  /** What the next layout is told about the change that triggered it: an expand, not a new focus. */
  let mergeHints: MergeHint[] = [];
  /**
   * Tells the next layout what kind of change it is for; forgotten once Vue has applied the change. Called
   * after the change is made, so `nextTick` waits for the flush that carries it. Changes in one tick queue
   * up: the layout that follows places the cards of all of them.
   */
  const hint = (h: MergeHint): void => {
    mergeHints.push(h);
    void nextTick().then(() => void (mergeHints = mergeHints.filter((x) => x !== h)));
  };
  const publish = (d: ProcessData, h: MergeHint): void => {
    notice.value = ''; // an earlier failure is old news once something merged
    data.value = d;
    hint(h);
  };
  /** Taken by the canvas when it lays out after an expand: where the new cards go (spec §6.7). */
  const takeMergeHints = (): MergeHint[] => {
    const hs = mergeHints;
    mergeHints = [];
    return hs;
  };

  /** Adds ids to what is drawn, up to the 300-card cap (spec D22): when some do not fit, the banner says so. */
  function admit(ids: Iterable<string>, force: Iterable<string> = []): void {
    // Cards that were on the map before the expand (the fan items a merged family now holds in full) stay whatever the cap says.
    const kept = [...force].filter((id) => nodeById.value.has(id) && !shown.value.has(id));
    if (kept.length) reveal(kept);
    const add: string[] = [];
    for (const id of ids) {
      const n = nodeById.value.get(id);
      if (!n || shown.value.has(id) || (n.type === 'record' && hiddenKinds.value.has(n.kind))) continue;
      add.push(id);
    }
    const room = Math.max(0, CARD_CAP - shown.value.size);
    if (add.length > room) capped.value = true;
    if (room && add.length) reveal(add.slice(0, room));
  }
  /** Remembers these cards as revealed, under keys that survive a regrouping of the rows. */
  function reveal(ids: Iterable<string>): void {
    const next = new Set(revealedKeys.value);
    for (const id of ids) {
      const n = nodeById.value.get(id);
      if (n) for (const k of stableKeys(n)) next.add(k);
    }
    revealedKeys.value = next;
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
    const key = opts.from ?? opts.node ?? sampleId;
    if (opening.has(key)) return Promise.resolve(); // a second click while it loads
    opening.add(key);
    return (withBusy(async () => {
      const { family, defs: relationDefs } = await loadFamilyAndDefs(api, sampleId);
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
    }) as Promise<void>).finally(() => void opening.delete(key));
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
      const fresh = page.items.filter((i) => i.collection === COLLECTION.sample || !held.has(i.id)).length;
      if (!fresh && page.remaining === 0) {
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
      const fresh = page.items.filter((i) => i.collection === COLLECTION.sample || !held.has(i.id)).length;
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
   * Plus on a card or a record in an Inside tray: loads what is not there yet, and shows what is one process step beyond it.
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
      const fan = d.fan && key === `${d.focus.collection}:${d.focus.id}` ? d.fan : (d.sideFans ?? []).find((f) => refKey(f.root) === key);
      // null = more to load with no count to show (D21): only an unset or zero remaining means there is nothing to load.
      if (fan && fan.remaining !== undefined && fan.remaining !== 0) return loadMore(key);
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

  return { expand, reset, loaded, takeMergeHints };
}
