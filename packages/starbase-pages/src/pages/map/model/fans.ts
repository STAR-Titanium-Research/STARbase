// Used-in fans and merging more data into what the Process map already shows (spec D20, §7 "Expand").
// Pure: no Vue, no I/O. `loadFamily.ts` reads; this turns a read into ProcessData and merges it.

import { kindOfCollection } from '../nodes/kinds';
import { FAN_PAGE, type UsedIn } from './loadFamily';
import { fanRootId, moreNodeId } from './buildGraph';
import type { Fan, Kind, LineageRow, OpRow, ProcessData, ProcessGraph, Ref, SampleRec, SideFan, StockOrigin, TestRow } from './types';

export const COLLECTION = { sample: 'physical_samples', operation: 'manufacturing_operations', test: 'test_sessions' } as const;

/** How a focus opens (spec D20): a sample's family; an operation or test through its sample; a used-in fan; not at all. */
export type FocusPlan = 'sample' | 'step' | 'fan';

const FAN_COLLECTIONS = new Set(['tools', 'equipment', 'insert_edges', 'fast_recipes', 'prep_recipes', 'raw_stock_lots', 'materials', 'projects', 'campaigns']);
/** Fans of samples (cards); the others are fans of operations and tests (collapsed containers). */
const SAMPLE_FAN_COLLECTIONS = new Set(['materials', 'projects', 'campaigns']);

export function focusPlan(collection: string): FocusPlan | null {
  if (collection === COLLECTION.sample) return 'sample';
  if (collection === COLLECTION.operation || collection === COLLECTION.test) return 'step';
  return FAN_COLLECTIONS.has(collection) ? 'fan' : null;
}

/** Has a used-in fan: what ＋ on a record inside the map can open. */
export const hasFan = (collection: string): boolean => FAN_COLLECTIONS.has(collection);

/** The kind a fan's root card is drawn as. */
export const fanKindOf = (collection: string): Kind => kindOfCollection(collection) ?? 'data_file';

const rowRef = (collection: string, row: { id: string; code: string }): Ref => ({ collection, id: row.id, code: row.code });
const when = (d: string | null): number => (d ? Date.parse(d) || 0 : 0);

/** One loaded page of a fan: what to add to the data, and what is still to come. */
export interface FanPage {
  operations: OpRow[];
  tests: TestRow[];
  samples: SampleRec[];
  items: Ref[];
  total: number;
  remaining: number;
}

/**
 * A `loadUsedIn` result as a page of the fan of `collection` (`page` is 1-based). "+N more" is counted from the
 * server's total and the pages read, never from the rows drawn: a stock lot page can hold fewer operations than
 * it has samples, and a page with none is not the end.
 */
export function fanPage(collection: string, used: UsedIn, page: number): FanPage {
  const total = Math.max(used.total, used.testsTotal ?? 0);
  const remaining = Math.max(0, total - FAN_PAGE * Math.max(1, page));
  if (SAMPLE_FAN_COLLECTIONS.has(collection)) {
    const samples = used.items as SampleRec[];
    return { operations: [], tests: [], samples, items: samples.map((s) => rowRef(COLLECTION.sample, s)), total, remaining };
  }
  const operations = used.items as OpRow[];
  const tests = used.tests ?? [];
  // Newest first across operations and tests.
  const rows: { ref: Ref; t: number }[] = [
    ...operations.map((o) => ({ ref: rowRef(COLLECTION.operation, o), t: when(o.date) })),
    ...tests.map((t) => ({ ref: rowRef(COLLECTION.test, t), t: when(t.date) })),
  ];
  rows.sort((a, b) => b.t - a.t);
  return { operations, tests, samples: [], items: rows.map((r) => r.ref), total, remaining };
}

const emptyData = (focus: ProcessData['focus']): ProcessData => ({
  focus,
  samples: [],
  operations: [],
  tests: [],
  lineage: [],
  stock: [],
  hidden: { ancestors: false, descendants: false, events: false, stock: false },
  truncated: false,
});

/** ProcessData of a map opened on a fan: the focus record, and its first page. */
export function fanData(root: Ref & { kind: Kind }, first: FanPage): ProcessData {
  return withFanPage(emptyData(root), `${root.collection}:${root.id}`, first, true);
}

const byId = <T extends { id: string }>(base: T[], add: T[]): T[] => {
  const seen = new Set(base.map((r) => r.id));
  return [...base, ...add.filter((r) => !seen.has(r.id))];
};

/**
 * Adds a page to the fan of the record `rootKey` (`<collection>:<id>`): the primary fan, or the side fan
 * with that root. A record the map already holds (an operation whose family is loaded) is not listed a
 * second time. `replace` starts the fan again (a first page).
 */
export function withFanPage(data: ProcessData, rootKey: string, page: FanPage, replace = false): ProcessData {
  const known = new Set([...data.operations.map((o) => o.id), ...data.tests.map((t) => t.id), ...data.samples.map((s) => s.id)]);
  // A sample is always listed (its wire from the record); an operation or test the map already holds is not.
  const items = page.items.filter((i) => i.collection === COLLECTION.sample || !known.has(i.id));
  const grow = (fan: Fan | undefined): Fan => ({
    items: replace || !fan ? items : [...fan.items, ...items.filter((i) => !fan.items.some((f) => f.id === i.id && f.collection === i.collection))],
    total: page.total,
    remaining: page.remaining,
  });
  const next: ProcessData = {
    ...data,
    samples: byId(data.samples, page.samples),
    operations: byId(data.operations, page.operations),
    tests: byId(data.tests, page.tests),
  };
  const sideIndex = (data.sideFans ?? []).findIndex((f) => `${f.root.collection}:${f.root.id}` === rootKey);
  if (`${data.focus.collection}:${data.focus.id}` === rootKey && sideIndex < 0) next.fan = grow(data.fan);
  else if (sideIndex >= 0) next.sideFans = (data.sideFans ?? []).map((f, i) => (i === sideIndex ? { ...f, ...grow(f) } : f));
  return next;
}

/** Adds a fan of a record inside the map (＋ on a tool in an Inside tray, a material card...). */
export function withSideFan(data: ProcessData, root: Ref & { kind: Kind }, first: FanPage): ProcessData {
  const side: SideFan = { root, items: [], total: first.total, remaining: first.remaining };
  const withRoot: ProcessData = { ...data, sideFans: [...(data.sideFans ?? []), side] };
  return withFanPage(withRoot, `${root.collection}:${root.id}`, first, true);
}

const lineageKey = (l: LineageRow) => `${l.parentId}>${l.childId}>${l.type}`;
const stockKey = (s: StockOrigin) => `${s.lotId}|${s.sampleId}`;
const uniqueBy = <T>(rows: T[], key: (r: T) => string): T[] => [...new Map(rows.map((r) => [key(r), r])).values()];

/**
 * `add` (the family of a sample) merged into `base`, by id: nothing is drawn twice. Keeps `base`'s focus and
 * hidden-record flags (they belong to the focus); a cut list in either marks the whole history partial.
 * A fan item whose operation or test the family now holds is dropped from its fan: the full container stands
 * in for the collapsed one.
 */
export function mergeProcessData(base: ProcessData, add: ProcessData): ProcessData {
  const operations = byId(base.operations, add.operations);
  const tests = byId(base.tests, add.tests);
  const gone = new Set([...add.operations.map((o) => o.id), ...add.tests.map((t) => t.id)]);
  const prune = <F extends Fan>(fan: F): F => ({ ...fan, items: fan.items.filter((i) => i.collection === COLLECTION.sample || !gone.has(i.id)) });
  const merged: ProcessData = {
    ...base,
    samples: byId(base.samples, add.samples),
    operations,
    tests,
    lineage: uniqueBy([...base.lineage, ...add.lineage], lineageKey) as LineageRow[],
    stock: uniqueBy([...base.stock, ...add.stock], stockKey) as StockOrigin[],
    truncated: base.truncated || add.truncated,
  };
  if (base.fan) merged.fan = prune(base.fan);
  if (base.sideFans) merged.sideFans = base.sideFans.map(prune);
  return merged;
}

/** Ids of the operations and tests still drawn as collapsed fan items. */
export function fanRowIds(data: ProcessData): Set<string> {
  const ids = new Set<string>();
  for (const fan of [data.fan, ...(data.sideFans ?? [])]) {
    for (const i of fan?.items ?? []) if (i.collection !== COLLECTION.sample) ids.add(i.id);
  }
  return ids;
}

/** Node ids of every fan on the map, in the order of the list: its record, what it lists, its "+N more" stub (those that are drawn). */
export function fanNodeIds(data: ProcessData, graph: ProcessGraph): Set<string> {
  const drawn = new Set(graph.nodes.map((n) => n.id));
  const out = new Set<string>();
  const add = (id: string) => void (drawn.has(id) && out.add(id));
  const fans: { root: Pick<Ref, 'collection' | 'id'>; items: Ref[] }[] = [];
  if (data.fan) fans.push({ root: data.focus, items: data.fan.items });
  fans.push(...(data.sideFans ?? []));
  for (const fan of fans) {
    add(fanRootId(fan.root));
    for (const i of fan.items) add(i.collection === COLLECTION.sample ? `s:${i.id}` : i.collection === COLLECTION.operation ? `op:${i.id}` : `test:${i.id}`);
    add(moreNodeId(fan.root));
  }
  return out;
}

/** What a record is called in the page's words: "this tool does not exist", and the crumb that leads back to its list. */
const WORDS: Record<string, [string, string]> = {
  physical_samples: ['sample', 'Samples'],
  manufacturing_operations: ['operation', 'Operations'],
  test_sessions: ['test', 'Tests'],
  tools: ['tool', 'Tools'],
  equipment: ['machine', 'Machines'],
  insert_edges: ['insert edge', 'Insert edges'],
  fast_recipes: ['recipe', 'Recipes'],
  prep_recipes: ['recipe', 'Recipes'],
  raw_stock_lots: ['stock lot', 'Stock lots'],
  materials: ['material', 'Materials'],
  projects: ['project', 'Projects'],
  campaigns: ['campaign', 'Campaigns'],
};
export const recordWord = (collection: string): { one: string; many: string } => {
  const [one, many] = WORDS[collection] ?? ['record', 'Records'];
  return { one, many };
};
