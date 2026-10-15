// Turns loaded data + batch groups into nodes and wires (spec §5.2). Pure: no Vue, no I/O.
//
// Node ids: sample `s:<id>`, container = its group id, junction `j:<parentId>:<type>`, stock lot
// `lot:<id>`, powder batch `pb:<opId>`, material `m:<sampleId>`. Socket ids `<nodeId>:in:<i>`,
// `<nodeId>:out:<i>`, and the bundle `<nodeId>:in:b` / `<nodeId>:out:b` (spec D8).

import { COLLECTION } from './collections';
import type {
  ContainerNode,
  Fan,
  Group,
  JunctionNode,
  Kind,
  MapNode,
  MoreNode,
  OpRow,
  ProcessCategory,
  ProcessData,
  ProcessGraph,
  Ref,
  RecordNode,
  SampleRow,
  Slot,
  StockOrigin,
  TestRow,
  Wire,
} from './types';
import { keySettings, mergeSettings, mergeSlots } from './formSlots';
import { isBundleSocket, nodeOfSocket } from './sockets';

export interface BuildGraphOpts {
  /** Inside-tray slots of one operation or test row. */
  slots: (row: OpRow | TestRow, kind: 'operation' | 'test') => Slot[];
  /** More rows than this fold: rows from index 2 on share the bundle sockets. Default 3. */
  maxRows?: number;
  /** Container (group) ids the person unfolded: they keep every row on its own socket. */
  unfolded?: ReadonlySet<string>;
}

/** The node a used-in fan hangs from: the focus record, or a record ＋ opened a fan of. A stock lot is its `lot:` card. */
export const fanRootId = (r: Pick<Ref, 'collection' | 'id'>): string => (r.collection === COLLECTION.stockLot ? `lot:${r.id}` : `f:${r.collection}:${r.id}`);
/** The "+N more" stub that continues the fan of a record. */
export const moreNodeId = (r: Pick<Ref, 'collection' | 'id'>): string => `more:${r.collection}:${r.id}`;

const DEFAULT_MAX_ROWS = 3;
/** What a sample card outside the loaded family is called when its code was not read. */
export const OTHER_PIECE = 'another piece';
/** Rows still shown on their own sockets once a container folds (spec D8: show 2, fold the rest). */
const SHOWN_WHEN_FOLDED = 2;

/** One operation or test turned into the facts the wiring needs. */
interface Planned {
  rec: OpRow | TestRow;
  kind: 'operation' | 'test';
  /** Known samples this row takes in. */
  inSamples: string[];
  /** The new sample this row makes (operation with an output sample other than its input); may be outside the loaded family. */
  outSample: string | null;
  /** False for a destructive test: nothing leaves it. */
  hasOut: boolean;
  /** Powder-batch text to draw as a card in front of this row (spec D12). */
  powderBatch: string | null;
}

/** Where a planned row ended up. */
interface Placed {
  nodeId: string;
  /** Input socket of each input sample. */
  inSocket: Map<string, string>;
  out: string | undefined;
}

/** A wire into a sample card, finalised once the card's incoming count is known. */
interface Pending {
  from: string;
  origin: string;
  carries: string | null;
  flow: Wire['flow'];
}

interface StepKey {
  t: number;
  seq: number;
  id: string;
}

/** Sort key of one step: date, then sequence, then id (spec §5.2 rule 3). A missing date sorts last. */
function timeOf(date: string | null): number {
  if (!date) return Infinity;
  const t = Date.parse(date);
  return Number.isNaN(t) ? Infinity : t;
}

function compareSteps(a: StepKey, b: StepKey): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const keyOf = (rec: OpRow | TestRow, sequence: number | null): StepKey => ({
  t: timeOf(rec.date),
  seq: sequence ?? Infinity,
  id: rec.id,
});

function stockLotNode(lot: StockOrigin): RecordNode {
  const id = `lot:${lot.lotId}`;
  return {
    id,
    type: 'record',
    kind: 'stock_lot',
    ref: { collection: COLLECTION.stockLot, id: lot.lotId, code: lot.lotCode },
    meta: lot.supplier ?? undefined,
    ins: [],
    outs: [`${id}:out:0`],
  };
}

/**
 * The title and the code of a container. A recorded batch is "Batch B-0003" and its code; one whose code was not read
 * is just "Batch" with no code. A probable batch is named by its method (it has no code of its own); a single row
 * by its method and its own code.
 */
function containerNames(group: Group, base: string, rowCode: string): { title: string; code: string } {
  const batch = group.batch;
  if (batch?.recorded) return batch.code ? { title: `Batch ${batch.code}`, code: batch.code } : { title: 'Batch', code: '' };
  return { title: batch ? `Probable batch · ${base}` : base, code: rowCode };
}

export function buildGraph(data: ProcessData, groups: Group[], opts: BuildGraphOpts): ProcessGraph {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const knownSamples = new Set(data.samples.map((s) => s.id));
  const known = (id: string | null): string | null => (id && knownSamples.has(id) ? id : null);

  const opById = new Map(data.operations.map((o) => [o.id, o]));
  const testById = new Map(data.tests.map((t) => [t.id, t]));

  // ---- wires -------------------------------------------------------------------------------
  const wires = new Map<string, Wire>();
  const addWire = (from: string, to: string, carries: string | null, flow: Wire['flow'], origin: string) => {
    if (nodeOfSocket(from) === nodeOfSocket(to)) return; // a container never feeds itself
    const id = `${from}>${to}`;
    if (wires.has(id)) return;
    wires.set(id, { id, from, to, carries, flow, bundled: isBundleSocket(from) || isBundleSocket(to), origin });
  };

  /** Wires into sample cards, in the order they were found. */
  const incoming = new Map<string, Pending[]>();
  const pushIncoming = (sampleId: string, pending: Pending) => {
    const list = incoming.get(sampleId);
    if (list) list.push(pending);
    else incoming.set(sampleId, [pending]);
  };

  // ---- 1. plan each row of each group ------------------------------------------------------
  const plannedByGroup = new Map<string, Planned[]>();
  const planned: Planned[] = [];
  for (const group of groups) {
    const rows: Planned[] = [];
    for (const id of group.rowIds) {
      let p: Planned;
      if (group.kind === 'operation') {
        const op = opById.get(id);
        if (!op) continue;
        const input = known(op.sampleId);
        // A branch is decided from the row itself, not from what is loaded: the pieces a cut made that are
        // outside the family (the siblings of the piece the map opened on) are still pieces, not in-place work.
        const output = op.outputSampleId && op.outputSampleId !== op.sampleId ? op.outputSampleId : null;
        if (!input && !(output && knownSamples.has(output))) continue; // nothing to draw a row for
        p = {
          rec: op,
          kind: 'operation',
          inSamples: input ? [input] : [],
          outSample: output,
          hasOut: true,
          powderBatch: op.powderBatch?.trim() || null,
        };
      } else {
        const test = testById.get(id);
        if (!test) continue;
        const subjects = [...new Set(test.subjectSampleIds.map(known).filter((s): s is string => !!s))];
        if (!subjects.length) continue;
        p = {
          rec: test,
          kind: 'test',
          inSamples: subjects,
          outSample: null,
          hasOut: test.category !== 'destructive',
          powderBatch: null,
        };
      }
      rows.push(p);
      planned.push(p);
    }
    plannedByGroup.set(group.id, rows);
  }

  // The operation that made each sample (the earliest when several claim it).
  const makingOp = new Map<string, OpRow>();
  for (const p of planned) {
    if (p.kind !== 'operation' || !p.outSample) continue;
    const op = p.rec as OpRow;
    const held = makingOp.get(p.outSample);
    if (!held || compareSteps(keyOf(op, op.sequence), keyOf(held, held.sequence)) < 0) makingOp.set(p.outSample, op);
  }

  const stockBySample = new Map<string, StockOrigin[]>();
  for (const s of data.stock) {
    if (!knownSamples.has(s.sampleId)) continue;
    const list = stockBySample.get(s.sampleId);
    if (list) list.push(s);
    else stockBySample.set(s.sampleId, [s]);
  }
  const lotNodes = new Map<string, RecordNode>();
  const lotNode = (lot: StockOrigin): RecordNode => {
    const id = `lot:${lot.lotId}`;
    let node = lotNodes.get(id);
    if (!node) lotNodes.set(id, (node = stockLotNode(lot)));
    return node;
  };

  // ---- 2. containers and their sockets ------------------------------------------------------
  const containers: ContainerNode[] = [];
  const powderNodes: RecordNode[] = [];
  const placedByRecord = new Map<string, Placed>();
  const recKey = (kind: 'operation' | 'test', id: string) => `${kind}:${id}`;

  for (const group of groups) {
    const rows = plannedByGroup.get(group.id) ?? [];
    const nodeId = group.id;
    const folded = rows.length > maxRows && !opts.unfolded?.has(group.id);
    const bundledAt = (i: number) => folded && i >= SHOWN_WHEN_FOLDED;

    let nextIn = 0;
    /** One input socket per distinct input sample: a grouped cut shares one. */
    const sampleSocket = new Map<string, string>();
    const sampleRows: SampleRow[] = [];

    rows.forEach((p, i) => {
      // What else feeds this row's input: the making operation takes its sample's stock lots; a
      // making operation with no lot but a powder-batch text gets the text-only card (D12).
      const outStock = p.outSample ? stockBySample.get(p.outSample) ?? [] : [];
      const lots = p.outSample && makingOp.get(p.outSample)?.id === p.rec.id ? outStock : [];
      const powder = known(p.outSample) && p.powderBatch && !outStock.length ? p.powderBatch : null;

      const inSocket = new Map<string, string>();
      let firstIn: string | undefined;
      for (const sample of p.inSamples) {
        let socket = sampleSocket.get(sample) ?? firstIn; // a test on several samples has one socket
        if (!socket) socket = bundledAt(i) ? `${nodeId}:in:b` : `${nodeId}:in:${nextIn++}`;
        sampleSocket.set(sample, socket);
        inSocket.set(sample, socket);
        firstIn ??= socket;
      }
      if (!firstIn && (lots.length || powder)) {
        firstIn = bundledAt(i) ? `${nodeId}:in:b` : `${nodeId}:in:${nextIn++}`;
      }

      const out = p.hasOut ? (bundledAt(i) ? `${nodeId}:out:b` : `${nodeId}:out:${i}`) : undefined;
      placedByRecord.set(recKey(p.kind, p.rec.id), { nodeId, inSocket, out });

      const row: SampleRow = { recordId: p.rec.id };
      const sampleId = p.outSample ?? p.inSamples[0];
      if (sampleId) row.sampleId = sampleId;
      if (firstIn) row.in = firstIn;
      if (out) row.out = out;
      if (firstIn && out && !p.outSample) row.inPlace = true;
      sampleRows.push(row);

      for (const lot of lots) addWire(`${lotNode(lot).id}:out:0`, firstIn!, null, 'stock', `lot:${lot.lotId}`);
      if (powder) {
        const id = `pb:${p.rec.id}`;
        powderNodes.push({
          id,
          type: 'record',
          kind: 'powder_batch',
          ref: { collection: COLLECTION.operation, id: p.rec.id, code: powder },
          meta: 'not linked to a stock lot',
          ins: [],
          outs: [`${id}:out:0`],
        });
        addWire(`${id}:out:0`, firstIn!, null, 'stock', id);
      }
      // The sample this row makes joins that sample's card.
      if (p.outSample && out) pushIncoming(p.outSample, { from: out, origin: nodeId, carries: p.outSample, flow: 'sample' });
    });

    // Only rows that are drawn feed the Inside tray and the settings (not skipped rows).
    const records = rows.map((p) => p.rec);
    const first = records[0];
    const category: ProcessCategory | 'test' =
      group.kind === 'test' ? 'test' : (((first as OpRow | undefined)?.category ?? null) as ProcessCategory);

    const method =
      first && group.kind === 'operation' ? (first as OpRow).methodName : (first as TestRow | undefined)?.testType;
    const base = method || (group.kind === 'operation' ? 'Operation' : 'Test');
    const { title, code } = containerNames(group, base, first?.code ?? group.id);
    const statuses = new Set(records.map((r) => r.status));

    containers.push({
      id: nodeId,
      type: 'container',
      kind: group.kind,
      group,
      title,
      code,
      status: statuses.size === 1 ? (first?.status ?? null) : undefined,
      category,
      rows: sampleRows,
      slots: mergeSlots(records.map((r) => opts.slots(r, group.kind))),
      settings: mergeSettings(records.map((r) => keySettings(r, category))),
      bundled: folded,
      probable: !!group.batch && !group.batch.recorded,
    });
  }

  // ---- 3. the per-sample chain: in-place work and tests in date order -----------------------
  interface Step extends StepKey {
    kind: 'inplace' | 'branch' | 'terminal';
    placed: Placed;
  }
  const steps = new Map<string, Step[]>();
  for (const p of planned) {
    const placed = placedByRecord.get(recKey(p.kind, p.rec.id))!;
    const key = keyOf(p.rec, p.kind === 'operation' ? (p.rec as OpRow).sequence : null);
    // An operation that makes another sample takes S in but leaves S where it is; a destructive
    // test ends S's chain.
    const kind = p.outSample ? 'branch' : p.hasOut ? 'inplace' : 'terminal';
    for (const sample of p.inSamples) {
      const list = steps.get(sample);
      if (list) list.push({ ...key, kind, placed });
      else steps.set(sample, [{ ...key, kind, placed }]);
    }
  }
  for (const [sample, list] of steps) {
    list.sort(compareSteps);
    let tail = `s:${sample}:out:0`;
    let tailOrigin = `s:${sample}`;
    for (const step of list) {
      addWire(tail, step.placed.inSocket.get(sample)!, sample, 'sample', tailOrigin);
      if (step.kind === 'inplace' && step.placed.out) {
        tail = step.placed.out;
        tailOrigin = step.placed.nodeId;
      }
    }
  }

  // ---- 4. lineage with no operation behind it becomes a junction (D10) ----------------------
  const covered = new Set<string>();
  for (const p of planned) {
    if (p.kind === 'operation' && p.inSamples[0] && p.outSample) covered.add(`${p.inSamples[0]}>${p.outSample}`);
  }
  const junctionById = new Map<string, JunctionNode>();
  for (const row of data.lineage) {
    if (!knownSamples.has(row.parentId) || !knownSamples.has(row.childId) || row.parentId === row.childId) continue;
    if (covered.has(`${row.parentId}>${row.childId}`)) continue;
    const id = `j:${row.parentId}:${row.type}`;
    let junction = junctionById.get(id);
    if (!junction) {
      junction = { id, type: 'junction', lineageType: row.type, parentId: row.parentId, outs: [], in: `${id}:in:0` };
      junctionById.set(id, junction);
      addWire(`s:${row.parentId}:out:0`, junction.in, row.parentId, 'sample', `s:${row.parentId}`);
    }
    if (junction.outs.some((o) => o.childId === row.childId)) continue;
    const socket = `${id}:out:${junction.outs.length}`;
    junction.outs.push({ socket, childId: row.childId, fraction: row.fraction });
    pushIncoming(row.childId, { from: socket, origin: id, carries: row.childId, flow: 'sample' });
  }

  // ---- 4b. used-in fans (D20): the record, a collapsed container or a sample card per item, "+N more" -----
  const fanNodes: MapNode[] = [];
  const fans: { root: Ref & { kind: Kind }; items: Ref[]; remaining: number | null; hidden: boolean }[] = [];
  if (data.fan) fans.push({ root: data.focus, items: data.fan.items, remaining: remainingOf(data.fan), hidden: !!data.fan.hidden });
  for (const f of data.sideFans ?? []) fans.push({ root: f.root, items: f.items, remaining: remainingOf(f), hidden: !!f.hidden });
  for (const fan of fans) {
    const rootId = fanRootId(fan.root);
    const rootOut = `${rootId}:out:0`;
    if (fan.root.collection === COLLECTION.stockLot) {
      if (!lotNodes.has(rootId)) lotNodes.set(rootId, { id: rootId, type: 'record', kind: 'stock_lot', ref: fan.root, ins: [], outs: [rootOut] });
    } else {
      fanNodes.push({ id: rootId, type: 'record', kind: fan.root.kind, ref: fan.root, ins: [], outs: [rootOut] });
    }
    for (const item of fan.items) {
      if (item.collection === COLLECTION.sample) {
        if (known(item.id)) pushIncoming(item.id, { from: rootOut, origin: rootId, carries: null, flow: 'stock' });
        continue;
      }
      const kind = item.collection === COLLECTION.operation ? 'operation' : item.collection === COLLECTION.test ? 'test' : null;
      if (!kind || placedByRecord.has(recKey(kind, item.id))) continue; // its family is loaded: the full container stands
      const row = kind === 'operation' ? opById.get(item.id) : testById.get(item.id);
      if (!row) continue;
      const node = collapsedContainer(kind, row);
      fanNodes.push(node);
      addWire(rootOut, node.rows[0].in!, null, 'stock', rootId);
    }
    if (fan.remaining !== 0) {
      fanNodes.push({ id: moreNodeId(fan.root), type: 'more', of: `${fan.root.collection}:${fan.root.id}`, remaining: fan.remaining } satisfies MoreNode);
    }
  }

  // ---- 5. stock lots into a card (no making operation), materials of roots -------------------
  for (const [sample, lots] of stockBySample) {
    if (makingOp.has(sample)) continue; // already wired into the making operation's input
    for (const lot of lots) {
      const node = lotNode(lot);
      pushIncoming(sample, { from: node.outs[0], origin: node.id, carries: null, flow: 'stock' });
    }
  }
  const materials: RecordNode[] = [];
  for (const s of data.samples) {
    if (incoming.has(s.id) || !s.materialRef) continue;
    const id = `m:${s.id}`;
    materials.push({ id, type: 'record', kind: 'material', ref: s.materialRef, ins: [], outs: [`${id}:out:0`] });
    pushIncoming(s.id, { from: `${id}:out:0`, origin: id, carries: null, flow: 'stock' });
  }

  // ---- 6. sample cards: one input socket per incoming wire (D11), folded past maxRows --------
  // A piece some operation made that is outside the loaded family (a sibling of the piece the map opened
  // on) is a small card of its own: "another piece" until the person opens it with ＋.
  const stubs = [...incoming.keys()]
    .filter((id) => !knownSamples.has(id))
    .map((id) => ({ id, code: data.pieces?.[id]?.code ?? OTHER_PIECE, nickname: data.pieces?.[id]?.nickname ?? null, form: data.pieces?.[id]?.form ?? null, status: null, projectId: null }));
  const sampleNodes: RecordNode[] = [...data.samples, ...stubs].map((s) => {
    const nodeId = `s:${s.id}`;
    const list = incoming.get(s.id) ?? [];
    const folded = list.length > maxRows;
    const ins: string[] = [];
    list.forEach((pending, i) => {
      const socket = folded && i >= SHOWN_WHEN_FOLDED ? `${nodeId}:in:b` : `${nodeId}:in:${i}`;
      if (!ins.includes(socket)) ins.push(socket);
      addWire(pending.from, socket, pending.carries, pending.flow, pending.origin);
    });
    return {
      id: nodeId,
      type: 'record',
      kind: 'sample',
      ref: { collection: COLLECTION.sample, id: s.id, code: s.code, ...(s.nickname ? { label: s.nickname } : {}) },
      status: s.status,
      meta: s.form ?? undefined,
      ins,
      outs: [`${nodeId}:out:0`],
      projectId: s.projectId,
    };
  });

  const nodes: MapNode[] = [
    ...sampleNodes,
    ...containers,
    ...junctionById.values(),
    ...lotNodes.values(),
    ...powderNodes,
    ...materials,
    ...fanNodes,
  ];

  // ---- 7. markers for records the person may not read (D21) ---------------------------------
  const hidden: ProcessGraph['hidden'] = [];
  const present = new Set(nodes.map((n) => n.id));
  const mark = (nodeId: string, h: ProcessData['hidden']) => {
    const add = (side: 'in' | 'out') => void (hidden.some((m) => m.nodeId === nodeId && m.side === side) || hidden.push({ nodeId, side }));
    if (h.ancestors || h.stock) add('in');
    if (h.descendants || h.events) add('out');
  };
  // A fan that skipped samples the person may not read: one marker on its root (the fan runs out of it), no count.
  for (const fan of fans) {
    const rootId = fanRootId(fan.root);
    if (fan.hidden && present.has(rootId)) mark(rootId, { ancestors: false, descendants: true, events: false, stock: false });
  }
  const focusNode = focusNodeId(data, groups, present);
  if (focusNode) mark(focusNode, data.hidden);
  // A family merged in with ＋ marks its own sample card, not the focus.
  for (const f of data.mergedFamilies ?? []) if (present.has(`s:${f.root}`)) mark(`s:${f.root}`, f.hidden);

  return { nodes, wires: [...wires.values()], hidden, truncated: data.truncated };
}

/** The node the hidden-record markers hang on: the focus record, else the first sample card. */
function focusNodeId(data: ProcessData, groups: Group[], present: Set<string>): string | null {
  const { kind, id } = data.focus;
  let candidate: string | null = null;
  if (kind === 'sample') candidate = `s:${id}`;
  else if (kind === 'operation' || kind === 'test') {
    candidate = groups.find((g) => g.kind === kind && g.rowIds.includes(id))?.id ?? null;
  } else candidate = fanRootId(data.focus);
  if (candidate && present.has(candidate)) return candidate;
  const firstSample = data.samples[0];
  return firstSample && present.has(`s:${firstSample.id}`) ? `s:${firstSample.id}` : null;
}

/** Rows still to load; null = more, but no number to show (a null remaining, or a fan with no count: D21). */
const remainingOf = (f: Fan): number | null => {
  if (f.remaining === null) return null;
  if (f.remaining !== undefined) return Math.max(0, f.remaining);
  return f.total === null ? null : Math.max(0, f.total - f.items.length);
};

/** A used-in fan item as a header-only container: its sample flow is loaded when the person expands it. */
function collapsedContainer(kind: 'operation' | 'test', row: OpRow | TestRow): ContainerNode {
  const id = kind === 'operation' ? `op:${row.id}` : `test:${row.id}`;
  const op = kind === 'operation' ? (row as OpRow) : null;
  const test = kind === 'test' ? (row as TestRow) : null;
  return {
    id,
    type: 'container',
    kind,
    group: { id, kind, rowIds: [row.id], batch: null },
    title: (op ? op.methodName : test?.testType) || (kind === 'operation' ? 'Operation' : 'Test'),
    code: row.code,
    status: row.status,
    category: op ? op.category : 'test',
    rows: [{ recordId: row.id, in: `${id}:in:0` }],
    slots: [],
    settings: [],
    bundled: false,
    collapsed: true,
    meta: row.date?.slice(0, 10) || undefined,
    probable: false,
  };
}
