// Batch grouping for the Process map (spec §5.3). Pure: rows in, groups out, every row in exactly
// one group. Recorded batches (batch_id) first, then — only when `probable` — guessed ones.

import type { Group, OpRow, ProcessCategory, TestRow } from './types';

export interface GroupBatchesOpts {
  /** Guess probable batches (the "Probable batches" chip). */
  probable: boolean;
  /** Header codes of recorded batches, by batch id ("B-0001"). Falls back to the id. */
  batchCodes?: Record<string, string>;
}

/** Categories whose different input samples are commonly processed together in one go. */
const TOGETHER: ReadonlySet<ProcessCategory> = new Set<ProcessCategory>([
  'sample_prep',
  'heat_treatment',
  'additive',
]);

/** Calendar day of an ISO timestamp, in UTC; null when absent or unparseable. */
function utcDay(date: string | null): string | null {
  if (!date) return null;
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Collects the keys' rows in first-seen order; a null key means "never groups". */
function bucket<T>(rows: T[], keyOf: (row: T) => string | null): T[][] {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return [...map.values()].filter((list) => list.length >= 2);
}

const keyOf = (...parts: (string | null)[]) => JSON.stringify(parts);

export function groupBatches(ops: OpRow[], tests: TestRow[], opts: GroupBatchesOpts): Group[] {
  const code = (batchId: string) => opts.batchCodes?.[batchId] ?? batchId;

  /** Groups, ordered by where their first row sits in the input. */
  const groups: Group[] = [];
  const firstSeen = new Map<string, number>();
  const rank = new Map<string, number>();
  [...ops, ...tests].forEach((r, i) => rank.set(r.id, i));

  const push = (group: Group) => {
    groups.push(group);
    firstSeen.set(group.id, Math.min(...group.rowIds.map((id) => rank.get(id) ?? Infinity)));
  };

  // 1. Recorded batches: same batch_id, any category. Operation and test batches stay apart.
  const opBatchIds = new Set<string>();
  const recorded = <T extends { id: string; batchId: string | null }>(
    rows: T[],
    kind: Group['kind'],
  ): T[] => {
    const byBatch = new Map<string, T[]>();
    for (const row of rows) {
      if (!row.batchId) continue;
      const list = byBatch.get(row.batchId);
      if (list) list.push(row);
      else byBatch.set(row.batchId, [row]);
    }
    for (const [batchId, list] of byBatch) {
      let id = `batch:${batchId}`;
      if (kind === 'operation') opBatchIds.add(batchId);
      else if (opBatchIds.has(batchId)) id = `batch:${batchId}:test`;
      push({ id, kind, rowIds: list.map((r) => r.id), batch: { recorded: true, code: code(batchId) } });
    }
    return rows.filter((r) => !r.batchId);
  };

  const freeOps = recorded(ops, 'operation');
  const freeTests = recorded(tests, 'test');

  // 2. Probable batches, operations only, on rows with no batch_id and no source_run_uid.
  const claimed = new Set<string>();
  if (opts.probable) {
    const candidates = freeOps.filter((o) => !o.sourceRunUid && utcDay(o.date) !== null);
    const probable = (list: OpRow[]) => {
      push({
        id: `probable:${list.map((r) => r.id).sort().join(',')}`,
        kind: 'operation',
        rowIds: list.map((r) => r.id),
        batch: { recorded: false },
      });
      for (const r of list) claimed.add(r.id);
    };

    // Same input sample (any category): a cut into pieces. Each row must make its own piece: passes that leave
    // the sample where it is (turning, polishing, in place) are a sequence, never a batch.
    for (const list of bucket(candidates, (o) =>
      o.sampleId && o.outputSampleId && o.outputSampleId !== o.sampleId ? keyOf(o.sampleId, o.methodId, o.equipmentId, utcDay(o.date)) : null,
    )) {
      probable(list);
    }

    // Several samples together (sample_prep, heat_treatment, additive); blank recipe equals blank. "Several
    // samples": passes on one sample are a sequence. The sample of a row is its input, else the one it makes
    // (an additive build from powder has no input), else the row itself.
    const sampleOf = (o: OpRow) => o.sampleId ?? o.outputSampleId ?? o.id;
    const rest = candidates.filter((o) => !claimed.has(o.id));
    for (const list of bucket(rest, (o) =>
      TOGETHER.has(o.category) ? keyOf(o.methodId, o.equipmentId, utcDay(o.date), o.recipeKey) : null,
    )) {
      if (new Set(list.map(sampleOf)).size >= 2) probable(list);
    }
  }

  // 3. Everything else is a single row.
  for (const o of freeOps) {
    if (!claimed.has(o.id)) push({ id: `op:${o.id}`, kind: 'operation', rowIds: [o.id], batch: null });
  }
  for (const t of freeTests) {
    push({ id: `test:${t.id}`, kind: 'test', rowIds: [t.id], batch: null });
  }

  return groups.sort((a, b) => (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0));
}
