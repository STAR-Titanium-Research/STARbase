// Runs ELK over the shown Process map nodes and returns top-left positions (spec §6.7).

import type { ELK } from 'elkjs/lib/elk-api';
import { elkInput, type Dir, type Sizes } from './model/elkInput';
import type { ProcessGraph } from './model/types';

let elk: Promise<ELK> | null = null;

/** One bundled (no worker) ELK instance, imported on first use. */
function getElk(): Promise<ELK> {
  elk ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return elk;
}

export function useElkLayout() {
  async function layout(
    graph: ProcessGraph,
    shown: Set<string>,
    sizes: Sizes,
    dir: Dir,
  ): Promise<Record<string, { x: number; y: number }>> {
    const result = await (await getElk()).layout(elkInput(graph, shown, sizes, dir));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const child of result.children ?? []) positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
    return positions;
  }
  return { layout };
}
