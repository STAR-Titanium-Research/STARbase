// Test fixture builders for the Process map model. Not imported by production code.

import { groupBatches } from './groupBatches';
import type { Group, LineageRow, OpRow, ProcessData, SampleRec, StockOrigin, TestRow } from './types';

let counter = 0;

export function mkOp(p: Partial<OpRow> = {}): OpRow {
  counter += 1;
  return {
    id: `op${counter}`,
    code: `OP-${counter}`,
    methodId: 'm1',
    methodName: 'Method',
    category: null,
    date: null,
    sequence: null,
    status: null,
    sampleId: null,
    outputSampleId: null,
    equipmentId: null,
    recipeKey: null,
    batchId: null,
    sourceRunUid: null,
    powderBatch: null,
    relations: {},
    settings: {},
    projectId: null,
    ...p,
  };
}

export function mkTest(p: Partial<TestRow> = {}): TestRow {
  counter += 1;
  return {
    id: `t${counter}`,
    code: `T-${counter}`,
    testType: null,
    category: null,
    date: null,
    status: null,
    subjectSampleIds: [],
    equipmentId: null,
    batchId: null,
    relations: {},
    settings: {},
    projectId: null,
    ...p,
  };
}

export function mkSample(id: string, p: Partial<SampleRec> = {}): SampleRec {
  return { id, code: id.toUpperCase(), form: null, status: null, projectId: null, materialRef: null, facts: {}, ...p };
}

export function mkLineage(parentId: string, childId: string, type: LineageRow['type'] = 'cut_from', fraction: number | null = null): LineageRow {
  return { parentId, childId, type, fraction };
}

export function mkStock(lotId: string, sampleId: string, p: Partial<StockOrigin> = {}): StockOrigin {
  return { lotId, lotCode: lotId.toUpperCase(), supplier: null, massUsedGrams: null, sampleId, ...p };
}

/** ProcessData with nothing in it, focused on the first sample (or `s1`). */
export function mkData(p: Partial<ProcessData> = {}): ProcessData {
  const focusId = p.samples?.[0]?.id ?? 's1';
  return {
    focus: { collection: 'physical_samples', id: focusId, code: focusId.toUpperCase(), kind: 'sample' },
    samples: [],
    operations: [],
    tests: [],
    lineage: [],
    stock: [],
    hidden: { ancestors: false, descendants: false, events: false, stock: false },
    truncated: false,
    ...p,
  };
}

/** Groups for a dataset the way the page makes them. */
export function groupsOf(data: ProcessData, probable = false): Group[] {
  return groupBatches(data.operations, data.tests, { probable });
}
