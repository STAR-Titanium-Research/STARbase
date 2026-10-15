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
  /**
   * Codes of samples that operations of the family made but that are outside it (the sibling pieces of a cut,
   * seen from one piece): they are drawn as small cards, "another piece" when the code was not read.
   */
  pieces?: Record<string, { code: string; form: string | null }>;
  /**
   * Codes of the recorded batches the rows above belong to, by batch id ("B-0003"). Only batches whose code was
   * read: a batch the person may not see the code of is still a group, headed "Batch".
   */
  batchCodes?: Record<string, string>;
  /**
   * Hidden-record flags of the families merged in with ＋, by the sample each was opened on: `hidden` above
   * belongs to the focus, and these say where else the person may not read records.
   */
  mergedFamilies?: { root: string; hidden: ProcessData['hidden'] }[];
  /** Opened on a record that is used by operations or samples (spec D20): the used-in fan of the focus. */
  fan?: Fan;
  /** Used-in fans merged in with ＋ on a record inside the map (a tool, a machine, a material...). */
  sideFans?: SideFan[];
}

/**
 * A page-by-page list of what used a record: operations or tests (drawn as collapsed containers) or
 * samples (cards). `items` are the refs loaded so far, in the order drawn. `total` is the server's count of
 * the main list, or null for a campaign or stock lot (their junction counts include records the person may not read,
 * spec D21). `remaining` is what is still to load ("+N more"): null = more to load, no number to show ("More").
 */
export interface Fan {
  items: Ref[];
  total: number | null;
  remaining?: number | null;
  /** A junction or provenance row of this fan named a sample the person may not read: one marker, no count (spec D21). */
  hidden?: boolean;
}
export interface SideFan extends Fan {
  root: Ref & { kind: Kind };
}

/**
 * A set of rows drawn as one container. `batch: null` = a single row, no batch. `stack`: consecutive passes on one
 * sample (same method and machine, in place) drawn as one card, a deck of them; never a batch.
 */
export interface Group {
  id: string;
  kind: 'operation' | 'test';
  rowIds: string[];
  batch: { recorded: true; code: string | null } | { recorded: false } | null;
  stack?: true;
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
  /** Same sample in and out (no new sample made): the container draws a pass-through line. */
  inPlace?: boolean;
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
  /** The method of an operation, the test type of a test ("Turning", "Tensile"): the title bar says it after the process. */
  method?: string;
  /** The date of the row, or "first – last" for a batch or a stack whose rows differ. */
  when?: string;
  /** A stack of passes on one sample (Group.stack): drawn as a deck, with "Unstack". */
  stacked?: boolean;
  status?: string | null;
  category: ProcessCategory | 'test';
  rows: SampleRow[];
  slots: Slot[];
  settings: { label: string; value: string }[];
  bundled: boolean;
  /** Header only (a used-in fan item whose family is not loaded yet): drawn without rows, Inside tray or settings. */
  collapsed?: boolean;
  /** The date line a collapsed container shows. */
  meta?: string;
  probable: boolean;
};

/** The "+N more" stub that ends a used-in fan: clicking it loads the next page. */
export type MoreNode = {
  id: string;
  type: 'more';
  /** The record whose fan it continues, `<collection>:<id>`. */
  of: string;
  /** Null: more to load, but a count would include records the person may not read (D21): the stub says "More". */
  remaining: number | null;
};

export type JunctionNode = {
  id: string;
  type: 'junction';
  lineageType: LineageRow['type'];
  parentId: string;
  outs: { socket: string; childId: string; fraction: number | null }[];
  in: string;
};

export type MapNode = RecordNode | ContainerNode | JunctionNode | MoreNode;

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

/** Where the Process map is in loading its focus. */
export type MapStatus = 'empty' | 'loading' | 'ready' | 'notVisible' | 'error';
