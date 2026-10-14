// Types of the Process map's pure model (spec §5.1). No Vue in here.

export type Kind =
  | 'sample'
  | 'operation'
  | 'test'
  | 'stock_lot'
  | 'powder_batch'
  | 'material'
  | 'equipment'
  | 'tool'
  | 'insert_edge'
  | 'recipe'
  | 'data_file'
  | 'person'
  | 'campaign'
  | 'project'
  | 'junction';

export type ProcessCategory =
  | 'machining'
  | 'sintering'
  | 'heat_treatment'
  | 'deformation'
  | 'additive'
  | 'sample_prep'
  | null;

export interface Ref {
  collection: string;
  id: string;
  code: string;
  label?: string;
}

export interface OpRow {
  id: string;
  code: string;
  methodId: string;
  methodName: string;
  category: ProcessCategory;
  date: string | null;
  sequence: number | null;
  status: string | null;
  sampleId: string | null;
  outputSampleId: string | null;
  equipmentId: string | null;
  recipeKey: string | null;
  batchId: string | null;
  sourceRunUid: string | null;
  powderBatch: string | null;
  relations: Record<string, Ref | null>;
  settings: Record<string, unknown>;
  projectId: string | null;
}

export interface TestRow {
  id: string;
  code: string;
  testType: string | null;
  category: 'nde' | 'destructive' | 'dynamic' | 'other' | null;
  date: string | null;
  status: string | null;
  subjectSampleIds: string[];
  equipmentId: string | null;
  batchId: string | null;
  relations: Record<string, Ref | null>;
  settings: Record<string, unknown>;
  projectId: string | null;
}

export interface SampleRec {
  id: string;
  code: string;
  form: string | null;
  status: string | null;
  projectId: string | null;
  materialRef: Ref | null;
  facts: Record<string, string>;
}

export interface LineageRow {
  parentId: string;
  childId: string;
  type: 'derived_from' | 'cut_from' | 'sintered_from' | 'powder_from';
  fraction: number | null;
}

export interface StockOrigin {
  lotId: string;
  lotCode: string;
  supplier: string | null;
  massUsedGrams: number | null;
  sampleId: string;
}

export interface ProcessData {
  focus: Ref & { kind: Kind };
  samples: SampleRec[];
  operations: OpRow[];
  tests: TestRow[];
  lineage: LineageRow[];
  stock: StockOrigin[];
  hidden: { ancestors: boolean; descendants: boolean; events: boolean; stock: boolean };
  truncated: boolean;
  fan?: { items: Ref[]; total: number };
}

/** A set of rows drawn as one container. `batch: null` = a single row, no batch. */
export interface Group {
  id: string;
  kind: 'operation' | 'test';
  rowIds: string[];
  batch: { recorded: true; code: string } | { recorded: false } | null;
}

/**
 * One row of a container. `recordId` is the operation or test of that row; `in` / `out` are socket
 * ids (`<nodeId>:in:<i>`, `<nodeId>:out:<i>`, bundle `<nodeId>:in:b` / `<nodeId>:out:b`).
 */
export interface SampleRow {
  recordId: string;
  sampleId?: string;
  in?: string;
  out?: string;
}

/** One slot of a container's Inside tray (a relation of the operation/test). */
export interface Slot {
  field: string;
  role: string;
  ref: Ref | null;
  major: boolean;
  /** Distinct records when the rows of a batch differ (or only some have the slot). */
  values?: Ref[];
  /** Merged slot only: some rows have it and some do not. */
  partial?: boolean;
}

export type RecordNode = {
  id: string;
  type: 'record';
  kind: Kind;
  ref: Ref;
  status?: string | null;
  meta?: string;
  ins: string[];
  outs: string[];
  projectId?: string | null;
};

export type ContainerNode = {
  id: string;
  type: 'container';
  kind: 'operation' | 'test';
  group: Group;
  title: string;
  code: string;
  status?: string | null;
  category: ProcessCategory | 'test';
  rows: SampleRow[];
  slots: Slot[];
  settings: { label: string; value: string }[];
  bundled: boolean;
  collapsed?: boolean;
  probable: boolean;
};

export type JunctionNode = {
  id: string;
  type: 'junction';
  lineageType: LineageRow['type'];
  parentId: string;
  outs: { socket: string; childId: string; fraction: number | null }[];
  in: string;
};

export type MapNode = RecordNode | ContainerNode | JunctionNode;

export interface Wire {
  id: string;
  from: string;
  to: string;
  carries: string | null;
  flow: 'sample' | 'stock';
  bundled: boolean;
  origin: string;
}

export interface HiddenMarker {
  nodeId: string;
  side: 'in' | 'out';
}

export interface ProcessGraph {
  nodes: MapNode[];
  wires: Wire[];
  hidden: HiddenMarker[];
  truncated: boolean;
}
