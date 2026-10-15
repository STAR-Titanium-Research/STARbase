// The order of the steps on one sample (spec §5.2 rule 3): date, then (recorded before draft), sequence, then id. buildGraph wires a
// sample's chain in this order and groupBatches stacks only passes that are next to each other in it, so both
// read it from here. Pure: no Vue, no I/O.

import type { OpRow, TestRow } from './types';

export interface StepKey {
  t: number;
  /** 1 for a draft step (edit mode), 0 for a recorded one: with the same date (or none), recorded steps come first. */
  d: number;
  seq: number;
  id: string;
}

/** Sort key of one step: date, then sequence, then id (spec §5.2 rule 3). A missing date sorts last. */
function timeOf(date: string | null): number {
  if (!date) return Infinity;
  const t = Date.parse(date);
  return Number.isNaN(t) ? Infinity : t;
}

export function compareSteps(a: StepKey, b: StepKey): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.d !== b.d) return a.d < b.d ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const keyOf = (rec: OpRow | TestRow, sequence: number | null): StepKey => ({
  t: timeOf(rec.date),
  d: rec.draft ? 1 : 0,
  seq: sequence ?? Infinity,
  id: rec.id,
});
