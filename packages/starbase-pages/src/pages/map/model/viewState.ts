// What the person did to the map (cards revealed with ＋, containers unfolded, "more" opened, the selection) is
// remembered under keys that do not change when the Probable batches chip regroups the rows: a record's own
// id, not the id of the container that happens to hold it. Pure: no Vue, no I/O.

import type { Group, MapNode } from './types';

/** The keys a node answers to: a container, the (kind, id) of each row it holds; any other card, its own id. */
export const stableKeys = (node: MapNode): string[] => (node.type === 'container' ? keysOfGroup(node.group) : [node.id]);

/** The keys of a group of rows (`operation:<id>`, `test:<id>`). */
export const keysOfGroup = (group: Pick<Group, 'kind' | 'rowIds'>): string[] => group.rowIds.map((id) => `${group.kind}:${id}`);

/** The ids of the nodes that answer to a key in `keys`. */
export function nodesWithKey(nodes: readonly MapNode[], keys: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (!keys.size) return out;
  for (const n of nodes) if (stableKeys(n).some((k) => keys.has(k))) out.add(n.id);
  return out;
}

/** `keys` with the node's keys added, or removed when the node already held any. */
export function flipKeys(keys: ReadonlySet<string>, node: MapNode): Set<string> {
  const mine = stableKeys(node);
  const next = new Set(keys);
  if (mine.some((k) => next.has(k))) for (const k of mine) next.delete(k);
  else for (const k of mine) next.add(k);
  return next;
}

/** The key a selection is remembered under: the first key of a node, an id the graph does not know as it is. */
export const selectionKey = (id: string, nodes: readonly MapNode[]): string => {
  const node = nodes.find((n) => n.id === id);
  return node ? stableKeys(node)[0] : id;
};

/** The id of the node that now answers to a remembered selection key; the key itself when no node does (a record inside a card). */
export function resolveSelection(key: string | null, nodes: readonly MapNode[]): string | null {
  if (key === null) return null;
  return nodes.find((n) => stableKeys(n).includes(key))?.id ?? key;
}
