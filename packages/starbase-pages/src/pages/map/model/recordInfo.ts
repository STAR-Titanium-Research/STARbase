// What the hover card and the rail say about a record on the Process map (spec §6.5, §6.6): kind, status,
// code, a title, facts, counts, and what to ask for when the record has data. Built only from what the
// map has already loaded (the family, the graph), so hovering costs no request. Pure: no Vue, no I/O.
//
// `id` is what the page's actions take: a node id, or a record inside a card (`<collection>:<id>`).

import { analysisLink, humanise, processLabel, recordRoute, type Fact } from '@d1/ui';
import { LINEAGE_LABEL, kindOfCollection, slotText } from '../nodes/kinds';
import { refKey } from '../nodes/actions';
import { OTHER_PIECE } from './buildGraph';
import { dateText } from './dates';
import { nodeOfSocket } from './sockets';
import type { ContainerNode, Kind, MapNode, OpRow, ProcessData, ProcessGraph, Ref, SampleRec, TestRow } from './types';

export interface RecordInfo {
  /** The id it was asked for. */
  id: string;
  kind: Kind;
  /** The record this is. */
  ref: Ref;
  /**
   * Where "Open record" goes when it is not the record page of `ref` (Force data and uploaded files have none):
   * a path, or null when there is nowhere to go. Absent: the record page. Read it with `openPath`.
   */
  open?: string | null;
  /** The heading. */
  code: string;
  /** The code describes the record (a probable batch, a lineage junction) rather than being a code you could type. */
  plain?: boolean;
  title?: string;
  status?: string | null;
  facts: Fact[];
  counts: { value: number; label: string }[];
  /** The numeric shape of a sample, for the drawing (`sampleDims`, `hasDrawableDims` read it). */
  geometry: Record<string, unknown> | null;
  /** The operation whose data (force figure, FAST run) may be shown; null when nothing can have any. */
  dataOf: Ref | null;
}

const COLLECTION_OF = { operation: 'manufacturing_operations', test: 'test_sessions' } as const;

/** The heading of a record: a tool or a campaign by its name with its code under it, anything else by its code and label. */
function named(ref: Ref): Pick<RecordInfo, 'code' | 'title' | 'plain'> {
  const name = slotText(ref);
  return name !== ref.code ? { code: name, title: ref.code, plain: true } : { code: ref.code, title: ref.label };
}

/** The number at the start of a fact such as "12 mm". */
const leadingNumber = (v: string | undefined): number | null => {
  const n = v === undefined ? NaN : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** The sample's form and the dimensions the card loaded (SampleRec keeps them as "<n> mm" facts). */
function geometryOf(s: SampleRec): Record<string, unknown> | null {
  if (!s.form) return null;
  const out: Record<string, unknown> = { form: s.form };
  for (const [label, key] of [['Diameter', 'diameter_mm'], ['Thickness', 'thickness_mm'], ['Length', 'length_mm']] as const) {
    const n = leadingNumber(s.facts[label]);
    if (n !== null) out[key] = n;
  }
  return out;
}


function slotFacts(node: ContainerNode): Fact[] {
  return node.slots
    .filter((s) => s.major)
    .map((s) => ({ label: s.role, value: s.ref ? slotText(s.ref) : s.values?.length ? (s.values.length === 1 ? slotText(s.values[0]) : `${s.values.length} different`) : '' }));
}

function sampleInfo(id: string, data: ProcessData, rec: SampleRec): RecordInfo {
  const ops = data.operations.filter((o) => o.sampleId === rec.id || o.outputSampleId === rec.id).length;
  const tests = data.tests.filter((t) => t.subjectSampleIds.includes(rec.id)).length;
  const pieces = new Set<string>();
  for (const l of data.lineage) if (l.parentId === rec.id) pieces.add(l.childId);
  for (const o of data.operations) if (o.sampleId === rec.id && o.outputSampleId && o.outputSampleId !== rec.id) pieces.add(o.outputSampleId);
  const facts: Fact[] = Object.entries(rec.facts).map(([label, value]) => ({ label, value }));
  if (rec.materialRef) facts.push({ label: 'Material', value: rec.materialRef.label ?? rec.materialRef.code });
  return {
    id,
    kind: 'sample',
    ref: { collection: 'physical_samples', id: rec.id, code: rec.code },
    code: rec.code,
    title: rec.form ? humanise(rec.form) : undefined,
    status: rec.status,
    facts,
    counts: [
      { value: ops, label: 'operations' },
      { value: tests, label: 'tests' },
      { value: pieces.size, label: 'pieces' },
    ].filter((c) => c.value > 0),
    geometry: geometryOf(rec),
    dataOf: null,
  };
}

function containerInfo(id: string, data: ProcessData, node: ContainerNode): RecordInfo | null {
  const rows: (OpRow | TestRow)[] = node.group.rowIds
    .map((rid) => (node.kind === 'operation' ? data.operations.find((o) => o.id === rid) : data.tests.find((t) => t.id === rid)))
    .filter((r): r is OpRow | TestRow => !!r);
  const first = rows[0];
  if (!first) return null;
  const facts: Fact[] = [];
  if (node.kind === 'operation') facts.push({ label: 'Process', value: processLabel((first as OpRow).category) });
  else if ((first as TestRow).testType) facts.push({ label: 'Type', value: (first as TestRow).testType });
  if (rows.length > 1) facts.push({ label: node.stacked ? 'Passes' : node.kind === 'operation' ? 'Operations' : 'Tests', value: rows.length });
  facts.push({ label: 'Date', value: dateText(rows.map((r) => r.date)) });
  facts.push(...slotFacts(node));
  facts.push(...node.settings.map((s) => ({ label: s.label, value: s.value })));
  const ref: Ref = { collection: COLLECTION_OF[node.kind], id: first.id, code: first.code };
  return {
    id,
    kind: node.kind,
    ref,
    // A probable batch has no code of its own; the first row's would stand for all of them.
    // (A recorded batch whose code was not read has none either: a dash, and the title says "Batch".)
    code: node.probable || node.stacked ? node.title : node.code || '–',
    plain: node.probable || node.stacked || undefined,
    title: node.probable ? undefined : node.stacked ? node.method : node.title,
    status: node.status,
    facts,
    // A collapsed container's samples are not loaded: it has none to count.
    counts: node.collapsed ? [] : [{ value: node.rows.length, label: node.rows.length === 1 ? 'sample' : 'samples' }],
    geometry: null,
    dataOf: node.kind === 'operation' ? ref : null,
  };
}

function nodeInfo(id: string, node: MapNode, data: ProcessData, graph: ProcessGraph): RecordInfo | null {
  if (node.type === 'more') return null;
  if (node.type === 'container') return containerInfo(id, data, node);

  if (node.type === 'junction') {
    const parent = data.samples.find((s) => s.id === node.parentId);
    return {
      id,
      kind: 'junction',
      ref: { collection: 'physical_samples', id: node.parentId, code: parent?.code ?? '' },
      code: LINEAGE_LABEL[node.lineageType],
      plain: true,
      facts: [{ label: 'Parent sample', value: parent?.code }],
      counts: [{ value: node.outs.length, label: node.outs.length === 1 ? 'piece' : 'pieces' }],
      geometry: null,
      dataOf: null,
    };
  }

  if (node.kind === 'sample') {
    const rec = data.samples.find((s) => `s:${s.id}` === node.id);
    if (rec) return sampleInfo(id, data, rec);
    // A piece some operation made, outside the loaded family: all the map knows is its card.
    return { id, kind: 'sample', ref: node.ref, code: node.ref.code, plain: node.ref.code === OTHER_PIECE || undefined, title: node.meta ? humanise(node.meta) : undefined, status: null, facts: [], counts: [], geometry: null, dataOf: null };
  }

  const fed = new Set(graph.wires.filter((w) => nodeOfSocket(w.from) === node.id).map((w) => nodeOfSocket(w.to))).size;
  const info: RecordInfo = {
    id,
    kind: node.kind,
    ref: node.ref,
    code: node.ref.code,
    title: node.ref.label ?? node.meta,
    ...(slotText(node.ref) !== node.ref.code ? named(node.ref) : {}),
    status: node.status,
    facts: [],
    counts: fed ? [{ value: fed, label: 'fed' }] : [],
    geometry: null,
    dataOf: null,
  };
  if (node.kind === 'stock_lot') {
    const origins = data.stock.filter((s) => `lot:${s.lotId}` === node.id);
    const grams = origins.reduce((sum, s) => sum + (s.massUsedGrams ?? 0), 0);
    info.title = undefined;
    info.facts = [
      { label: 'Supplier', value: node.meta },
      { label: 'Mass used', value: origins.some((s) => s.massUsedGrams !== null) ? `${Number(grams.toPrecision(6))} g` : '' },
    ];
    info.counts = [{ value: new Set(origins.map((s) => s.sampleId)).size, label: 'samples' }];
  }
  return info;
}

/**
 * Where a record inside a card opens, when it is not its Data Studio form: Force data is a file path with no
 * record of its own, so it opens the operation that holds it in the Force dashboard (null when that operation is
 * not on the map); an uploaded data file opens in the file library. `undefined` = the record page.
 */
function openOf(ref: Ref, data: ProcessData): string | null | undefined {
  if (ref.collection === 'force_file') {
    const op = data.operations.find((o) => o.relations.force_file_id?.id === ref.id);
    return op ? analysisLink(op.id, 'machining')!.to : null;
  }
  if (ref.collection === 'directus_files') return `/files/${encodeURIComponent(ref.id)}`;
  return undefined;
}

/** Where "Open record" goes for `info`; null when there is nowhere to go (the button is not drawn). */
export const openPath = (info: Pick<RecordInfo, 'ref' | 'open'>): string | null =>
  info.open === undefined ? recordRoute(info.ref.collection, info.ref.id) : info.open;

/** A record shown inside a card's Inside tray: what kind it is and how many steps in the map use it. */
function slotInfo(id: string, data: ProcessData, graph: ProcessGraph): RecordInfo | null {
  let ref: Ref | undefined;
  let steps = 0;
  for (const n of graph.nodes) {
    if (n.type !== 'container') continue;
    const hit = n.slots.flatMap((s) => (s.ref ? [s.ref] : (s.values ?? []))).find((r) => refKey(r) === id);
    if (!hit) continue;
    ref ??= hit;
    steps += 1;
  }
  if (!ref) return null;
  const open = openOf(ref, data);
  // Force data is the data of the operation that holds it: its card shows that operation's Fz figure.
  const holder = ref.collection === 'force_file' ? data.operations.find((o) => o.relations.force_file_id?.id === ref.id) : undefined;
  return {
    id,
    kind: kindOfCollection(ref.collection) ?? 'data_file',
    ref,
    ...(open === undefined ? {} : { open }),
    ...named(ref),
    facts: [],
    counts: [{ value: steps, label: 'steps' }],
    geometry: null,
    dataOf: holder ? { collection: COLLECTION_OF.operation, id: holder.id, code: holder.code } : null,
  };
}

export function recordInfo(data: ProcessData, graph: ProcessGraph, id: string): RecordInfo | null {
  const node = graph.nodes.find((n) => n.id === id);
  return node ? nodeInfo(id, node, data, graph) : slotInfo(id, data, graph);
}
