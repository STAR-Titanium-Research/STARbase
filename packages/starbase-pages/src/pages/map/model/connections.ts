// What a record on the Process map is connected to, grouped for the rail's Connections section
// (spec §6.5). Pure: no Vue, no I/O.
//
// Entries are `Ref`s plus the id the page's actions take for them (`nodeId`: a node id, or a slot
// record's `<collection>:<id>`), so a click selects it and a hover opens its card. `label` is the short
// word on the right of a row: the step's name, a lineage word ("cut from"), a slot's role.
//
// Junctions (lineage with no operation behind it) are never listed: they are passed through to the
// sample on the other side, with the lineage word as the label.

import type { ContainerNode, JunctionNode, MapNode, ProcessGraph, Ref, Wire } from './types';
import { nodeOfSocket } from './sockets';
import { refKey } from '../nodes/actions';

export const CONNECTION_GROUPS = ['Came in from', 'Went on to', 'Inside', 'Used in', 'In this project'] as const;
export type ConnectionGroup = (typeof CONNECTION_GROUPS)[number];

export interface Connection extends Ref {
  /** What select / hover take for this entry. */
  nodeId: string;
}

export type Connections = Partial<Record<ConnectionGroup, Connection[]>>;

/** "cut from" going back, "cut into" going on. */
const BACK_LABEL: Record<JunctionNode['lineageType'], string> = {
  cut_from: 'cut from',
  sintered_from: 'sintered from',
  powder_from: 'powder from',
  derived_from: 'derived from',
};
const FORWARD_LABEL: Record<JunctionNode['lineageType'], string> = {
  cut_from: 'cut into',
  sintered_from: 'sintered into',
  powder_from: 'powder into',
  derived_from: 'derived into',
};

const COLLECTION_OF = { operation: 'manufacturing_operations', test: 'test_sessions' } as const;

const containerRef = (n: ContainerNode): Connection => ({
  collection: COLLECTION_OF[n.kind],
  id: n.group.rowIds[0] ?? n.id,
  code: n.code,
  label: n.title,
  nodeId: n.id,
});

/** The entry of a node that is not a junction. */
function entryOf(node: MapNode, label?: string): Connection | null {
  if (node.type === 'record') return { ...node.ref, label: label ?? node.meta ?? node.ref.label, nodeId: node.id };
  if (node.type === 'container') return { ...containerRef(node), ...(label ? { label } : {}) };
  return null;
}

export function connectionsOf(graph: ProcessGraph, id: string): Connections {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Connections = {};
  const add = (group: ConnectionGroup, entry: Connection | null) => {
    if (!entry) return;
    const list = (out[group] ??= []);
    if (!list.some((e) => e.nodeId === entry.nodeId)) list.push(entry);
  };

  /** The entries across `wire` from `self`: the node on the other end, a junction passed through to its other side. */
  const across = (wire: Wire, self: string, group: ConnectionGroup) => {
    const direction = nodeOfSocket(wire.from) === self ? 'on' : 'in';
    const other = byId.get(direction === 'on' ? nodeOfSocket(wire.to) : nodeOfSocket(wire.from));
    if (!other) return;
    if (other.type !== 'junction') return add(group, entryOf(other));
    if (direction === 'in') {
      // A junction feeds this card: its parent sample is where it was cut from.
      const parent = byId.get(`s:${other.parentId}`);
      if (parent) add(group, entryOf(parent, BACK_LABEL[other.lineageType]));
    } else {
      for (const o of other.outs) {
        const child = byId.get(`s:${o.childId}`);
        if (child) add(group, entryOf(child, FORWARD_LABEL[other.lineageType]));
      }
    }
  };

  const node = byId.get(id);
  if (node) {
    for (const w of graph.wires) {
      if (nodeOfSocket(w.to) === id) across(w, id, 'Came in from');
      if (nodeOfSocket(w.from) === id) across(w, id, 'Went on to');
    }
    if (node.type === 'container') {
      for (const s of node.slots) {
        for (const r of s.ref ? [s.ref] : (s.values ?? [])) add('Inside', { ...r, label: s.role, nodeId: refKey(r) });
      }
    }
    return out;
  }

  // Not a node: a record seen inside cards. It is "Used in" every container that holds it, and a
  // project also has the samples that belong to it.
  const slotRecord = (n: MapNode) =>
    n.type === 'container' ? n.slots.flatMap((s) => (s.ref ? [s.ref] : (s.values ?? []))).find((r) => refKey(r) === id) : undefined;
  let record: Ref | undefined;
  for (const n of graph.nodes) {
    const hit = slotRecord(n);
    if (!hit) continue;
    record ??= hit;
    add('Used in', entryOf(n));
  }
  if (record?.collection === 'projects') {
    for (const n of graph.nodes) {
      if (n.type === 'record' && n.kind === 'sample' && n.projectId === record.id) add('In this project', entryOf(n));
    }
  }
  return out;
}

/** How many entries in all. */
export const connectionCount = (c: Connections): number => Object.values(c).reduce((n, list) => n + (list?.length ?? 0), 0);

/** The groups that have entries, in the order the rail shows them. */
export const orderedGroups = (c: Connections): { group: ConnectionGroup; items: Connection[] }[] =>
  CONNECTION_GROUPS.flatMap((group) => (c[group]?.length ? [{ group, items: c[group]! }] : []));
