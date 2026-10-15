// The order of the steps on one sample (spec §5.2 rule 3): date, then sequence, then id. buildGraph wires a
// sample's chain in this order and groupBatches stacks only passes that are next to each other in it, so both
// read it from here. Pure: no Vue, no I/O.

import type { OpRow, TestRow } from './types';

export interface StepKey {
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

export function compareSteps(a: StepKey, b: StepKey): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const keyOf = (rec: OpRow | TestRow, sequence: number | null): StepKey => ({
  t: timeOf(rec.date),
  seq: sequence ?? Infinity,
  id: rec.id,
});
