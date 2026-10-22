// What data a record on the Process map has to show in a hover card or the rail (spec §6.6): the Fz
// force figure of a machining operation with a finished force analysis, or "FAST run data" for a
// sintering run with finished run data, or "Conform run data" (with a small trace of the run window) for a Conform run
// with a log linked. It reuses the list pages' plot requests (`plotRequests` /
// `mergePlots`): the same two reads of the hidden analysis collections, which a role may be refused, in
// which case the answer is `none`. It never downloads a data file: the figure is a Directus asset the
// browser loads as a small image (`assetThumbUrl`), the plotter is a link.

import { ConformLogHiddenError, LOG_LOAD_FAILED, LOG_NOT_VISIBLE, loadConformRun, loadLogTrace } from '@d1/fast-plotting';
import { analysisLink, mergePlots, plotRequests, type HostApi, type RowPlots } from '@d1/ui';
import { conformApi } from '../../conformApi';
import { conformThumb, type ConformThumb } from './conformThumb';
import { chunkByBudget } from './requests';
import type { Ref } from './types';

const OPERATIONS = 'manufacturing_operations';

export interface DataPreview {
  kind: 'force' | 'fast' | 'conform' | 'none';
  /** The Fz figure's file id (force only, when the analysis made one). */
  imageFileId?: string;
  /** Where "Open in plotter" goes; empty for `none`. */
  plotterPath: string;
  /** The data file's name, when a record can name one. */
  fileName?: string;
  /** Conform only: wheel speed and Tooling 1 over the run window (absent while the run has no window, or when the log cannot be read). */
  thumb?: ConformThumb;
  /** Conform only: why there is no trace when the run has a window: "Conform log not visible to you" (the file is forbidden) or "Could not load the Conform log". */
  thumbNote?: string;
}

/** What `conformThumbs` found for one run: its trace, or the reason it has none to show. */
export interface ConformThumbResult {
  thumb?: ConformThumb;
  note?: string;
}

/** Conform thumbnails read the log's CSV (once per log, cached): no more than this many runs per call, the rest show words only. */
export const CONFORM_THUMB_CAP = 12;

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
  if (plots?.conform) return { kind: 'conform', plotterPath: analysisLink(id, 'conform')!.to };
  return { ...NONE };
}

/**
 * The run's window trace, or the reason there is none: the log row or its file is forbidden to this person ("Conform log not
 * visible to you"), or the log could not be loaded ("Could not load the Conform log"). A run with no window, or whose window holds
 * no row, has neither. Never throws.
 */
async function thumbOf(api: HostApi, id: string): Promise<ConformThumbResult> {
  try {
    const http = conformApi(api);
    const { run, log, logHidden } = await loadConformRun(http, id);
    if (logHidden) return { note: LOG_NOT_VISIBLE };
    if (!run || !log) return {};
    const trace = await loadLogTrace(http, log);
    const thumb = conformThumb(trace, log, run);
    return thumb ? { thumb } : {};
  } catch (e) {
    return { note: e instanceof ConformLogHiddenError ? LOG_NOT_VISIBLE : LOG_LOAD_FAILED };
  }
}

/**
 * The data preview of each record, keyed by its id. Only operations can have data; everything else is
 * `none` without a request. Three reads per chunk of operations (force analyses, FAST run data, Conform run data); a read
 * that fails only means that kind of data is not shown. A Conform run's window trace comes later, from `conformThumbs`.
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

/**
 * The window traces of the Conform runs among `previews` (by operation id), read after the previews themselves are shown: a
 * trace costs a CSV download (once per log, cached), which must not hold back the Fz figures. Only runs with no thumbnail and no note yet (one
 * that already says why it has none is not asked again, and does not take a place in the cap),
 * at most CONFORM_THUMB_CAP per call; a run with nothing to show (no window) is left out, and one whose log cannot be read carries
 * the reason as its note.
 */
export async function conformThumbs(api: HostApi, previews: Record<string, DataPreview>): Promise<Record<string, ConformThumbResult>> {
  const ids = Object.keys(previews).filter((id) => previews[id].kind === 'conform' && !previews[id].thumb && !previews[id].thumbNote).slice(0, CONFORM_THUMB_CAP);
  const out: Record<string, ConformThumbResult> = {};
  await Promise.all(
    ids.map(async (id) => {
      const result = await thumbOf(api, id);
      if (result.thumb || result.note) out[id] = result;
    }),
  );
  return out;
}
