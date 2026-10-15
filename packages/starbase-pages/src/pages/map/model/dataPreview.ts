// What data a record on the Process map has to show in a hover card or the rail (spec §6.6): the Fz
// force figure of a machining operation with a finished force analysis, or "FAST run data" for a
// sintering run with finished run data. It reuses the list pages' plot requests (`plotRequests` /
// `mergePlots`): the same two reads of the hidden analysis collections, which a role may be refused, in
// which case the answer is `none`. It never downloads a data file: the figure is a Directus asset the
// browser loads as a small image (`assetThumbUrl`), the plotter is a link.

import { analysisLink, mergePlots, plotRequests, type HostApi, type RowPlots } from '@d1/ui';
import { chunkByBudget } from './loadFamily';
import type { Ref } from './types';

const OPERATIONS = 'manufacturing_operations';

export interface DataPreview {
  kind: 'force' | 'fast' | 'none';
  /** The Fz figure's file id (force only, when the analysis made one). */
  imageFileId?: string;
  /** Where "Open in plotter" goes; empty for `none`. */
  plotterPath: string;
  /** The data file's name, when a record can name one. */
  fileName?: string;
}

/** What `mergePlots` takes: each request's rows, or null when it failed. */
type Answers = Parameters<typeof mergePlots>[2];

const NONE: DataPreview = { kind: 'none', plotterPath: '' };

function previewOf(id: string, plots: RowPlots | undefined): DataPreview {
  if (plots?.force) {
    return {
      kind: 'force',
      ...(plots.frmFz ? { imageFileId: plots.frmFz } : {}),
      plotterPath: analysisLink(id, 'machining')!.to,
    };
  }
  if (plots?.fast) return { kind: 'fast', plotterPath: analysisLink(id, 'sintering')!.to };
  return { ...NONE };
}

/**
 * The data preview of each record, keyed by its id. Only operations can have data; everything else is
 * `none` without a request. Two reads per chunk of operations (force analyses, FAST run data); a read
 * that fails only means that kind of data is not shown.
 */
export async function dataPreview(api: HostApi, refs: Ref[]): Promise<Record<string, DataPreview>> {
  const out: Record<string, DataPreview> = {};
  const opIds: string[] = [];
  for (const r of refs) {
    if (r.collection === OPERATIONS) opIds.push(r.id);
    else out[r.id] = { ...NONE };
  }
  const unique = [...new Set(opIds)];
  // Each chunk's request line stays within the budget, whatever the ids look like.
  const chunks = chunkByBudget(unique, (chunk) => plotRequests(OPERATIONS, chunk)[0]?.params ?? {});
  await Promise.all(
    chunks.map(async (chunk) => {
      const answers = await Promise.all(
        plotRequests(OPERATIONS, chunk).map(async (r) => {
          try {
            const res = await api.get(r.path, { params: r.params });
            const data = res.data?.data;
            return [r.key, Array.isArray(data) ? data : null] as const;
          } catch {
            return [r.key, null] as const;
          }
        }),
      );
      const plots = mergePlots(OPERATIONS, chunk, Object.fromEntries(answers) as Answers);
      for (const id of chunk) out[id] = previewOf(id, plots[id]);
    }),
  );
  return out;
}
