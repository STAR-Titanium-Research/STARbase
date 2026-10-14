// The Process map's only module that talks to the API (spec §7). Through `HostApi` only, so the
// signed-in person's permissions apply and no Directus SDK is imported (`hostNeutral` guard).
//
//   loadFamily      a sample's whole family: trace, operations, tests, genealogy, samples
//   loadRelationDefs the relations of a form, read at runtime for the Inside tray (null when refused)
//   loadUsedIn      the used-in fan of a tool, machine, edge, recipe, stock lot, material, project, campaign
//
// Filters go as a JSON string (`filter: JSON.stringify(...)`), like indexQuery and plotData do: a list of
// 150 ids as bracketed query keys would run into the 20-element array limit of the query parser.

import { isNotVisible, operationLabel, type HostApi, type TraceResponse } from '@d1/ui';
import { KEY_SETTING_FIELDS, type RelationDef } from './formSlots';

/** The relations of the two forms, as `loadRelationDefs` read them at runtime. */
export interface FormDefs {
  operation: RelationDef[];
  test: RelationDef[];
}
import type { LineageRow, OpRow, ProcessCategory, ProcessData, Ref, SampleRec, StockOrigin, TestRow } from './types';

// ---- constants -------------------------------------------------------------------------------

/** Most ids in one request, whatever the budget says. */
const CHUNK = 150;
/** Encoded query string of one request, in bytes: filter + fields + sort + limit (typical request-line limit 8 KB). */
const QUERY_BUDGET = 6000;
/** Rows per used-in page (spec D20). */
export const FAN_PAGE = 20;

interface RelSpec {
  collection: string;
  /** Primary key of the target collection. */
  id: string;
  /** First non-empty wins as the Ref's `code`. */
  code: string[];
  /** Shown as the Ref's `label` when it differs from the code. */
  label?: string;
}

const RELATIONS = {
  equipment_id: { collection: 'equipment', id: 'equipment_id', code: ['equipment_code'], label: 'equipment_name' },
  tool_id: { collection: 'tools', id: 'tool_id', code: ['tool_code'], label: 'tool_name' },
  insert_edge_id: { collection: 'insert_edges', id: 'edge_id', code: ['edge_code'] },
  project_id: { collection: 'projects', id: 'project_id', code: ['project_code'], label: 'project_name' },
  campaign_id: { collection: 'campaigns', id: 'campaign_id', code: ['campaign_code'], label: 'name' },
  material_id: { collection: 'materials', id: 'material_id', code: ['alloy_code', 'common_name'], label: 'common_name' },
  source_recipe_id: { collection: 'prep_recipes', id: 'recipe_id', code: ['name'] },
  fast_recipe_id: { collection: 'fast_recipes', id: 'id', code: ['name'] },
  operator_person_id: { collection: 'people', id: 'person_id', code: ['full_name'] },
  owner_person_id: { collection: 'people', id: 'person_id', code: ['full_name'] },
} satisfies Record<string, RelSpec>;

type RelField = keyof typeof RELATIONS;

const OPERATION_RELATIONS: RelField[] = [
  'equipment_id',
  'tool_id',
  'insert_edge_id',
  'project_id',
  'campaign_id',
  'material_id',
  'source_recipe_id',
  'fast_recipe_id',
  'operator_person_id',
  'owner_person_id',
];
const TEST_RELATIONS: RelField[] = [
  'equipment_id',
  'insert_edge_id',
  'project_id',
  'campaign_id',
  'operator_person_id',
  'owner_person_id',
];

const relationFields = (fields: RelField[]): string[] =>
  fields.flatMap((f) => {
    const spec: RelSpec = RELATIONS[f];
    return [`${f}.${spec.id}`, ...spec.code.map((c) => `${f}.${c}`), ...(spec.label ? [`${f}.${spec.label}`] : [])];
  });

const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Inline setting fields of the key settings (formSlots.KEY_SETTING_FIELDS); `test_type` is its own column. */
const settingFields = (categories: (keyof typeof KEY_SETTING_FIELDS)[]): string[] =>
  unique(
    categories.flatMap((c) => KEY_SETTING_FIELDS[c].flatMap((d) => d.fields.map((f) => f.field))).filter((f) => f !== 'test_type'),
  );

const OPERATION_SETTING_FIELDS = settingFields(['sintering', 'machining', 'heat_treatment', 'additive', 'deformation']);
const TEST_SETTING_FIELDS = settingFields(['test']);

const OPERATION_FIELDS = [
  'operation_id',
  'pass_code',
  'operation_sequence',
  'operation_date',
  'process_category',
  'sample_id',
  'output_sample_id',
  'source_run_uid',
  'sintering_batch_number',
  // FAST recipe: `fast_recipe_id` (relation, above) where set; the typed number stays as the recipe key.
  'sintering_recipe_number',
  // TEXT column holding a file path or name, not a relation (mapped to a Ref by hand).
  'force_file_id',
  'method_id.method_id',
  'method_id.method_name',
  ...relationFields(OPERATION_RELATIONS),
  ...OPERATION_SETTING_FIELDS,
];

const TEST_FIELDS = [
  'session_id',
  'sample_id',
  'test_code',
  'test_type',
  'test_category',
  'session_date',
  'status',
  ...relationFields(TEST_RELATIONS),
  'session_data_files.directus_files_id.id',
  'session_data_files.directus_files_id.title',
  'session_data_files.directus_files_id.filename_download',
  ...TEST_SETTING_FIELDS,
];

// The recorded batch of an operation or test (spec D14). `batch_id` is only asked for when the runtime field defs of
// the collection list it (a database not yet migrated has no such column, and asking would refuse the whole read).
const BATCH_FIELDS = ['batch_id.batch_id', 'batch_id.code'];
const hasBatch = (defs: RelationDef[] | undefined): boolean => !!defs?.some((d) => d.field === 'batch_id' && !d.alias);

/** What a read adds to the fixed field list: the extra relations, and the batch when the defs list it. */
interface Optional {
  extras: Extra[];
  batch: boolean;
}

/**
 * The batch of a row as Directus returns it: an object (`batch_id` and `code`), a bare id when the person may not read
 * the batch itself, or null. A bare id is still a batch (the rows group on it) but has no code; null is no batch.
 */
function batchOf(value: unknown): { id: string; code: string | null } | null {
  if (value && typeof value === 'object') {
    const id = idOf((value as Json).batch_id);
    return id ? { id, code: str((value as Json).code) } : null;
  }
  const id = idOf(value);
  return id ? { id, code: null } : null;
}

/** Header codes of the batches seen on `rows`, added to `codes`. */
function collectBatchCodes(rows: Json[], codes: Record<string, string>): void {
  for (const row of rows) {
    const batch = batchOf(row.batch_id);
    if (batch?.code) codes[batch.id] = batch.code;
  }
}

// Subjects of a test: the M2A junction `test_sessions_subject(test_sessions_id, collection, item)`, whose
// alias on `test_sessions` is `subject` (db/migrations/20260703000064_test_subject_directus_meta.sql:
// `directus_fields` row, collection test_sessions, field `subject`, special m2a).
const SUBJECT_ALIAS = 'subject';
const SUBJECT_FIELDS = [`${SUBJECT_ALIAS}.collection`, `${SUBJECT_ALIAS}.item`];

const SAMPLE_FIELDS = [
  'sample_id',
  'sample_code',
  'form',
  'current_status',
  'mass_grams',
  'diameter_mm',
  'thickness_mm',
  'length_mm',
  'project_id.project_id',
  'material_id.material_id',
  'material_id.common_name',
  'material_id.alloy_code',
];

/** Facts shown on a sample card, in order: column and unit. */
const SAMPLE_FACTS: { label: string; field: string; unit: string }[] = [
  { label: 'Mass', field: 'mass_grams', unit: 'g' },
  { label: 'Diameter', field: 'diameter_mm', unit: 'mm' },
  { label: 'Thickness', field: 'thickness_mm', unit: 'mm' },
  { label: 'Length', field: 'length_mm', unit: 'mm' },
];

const GENEALOGY_FIELDS = ['child_sample_id', 'parent_sample_id', 'relationship_type', 'fraction'];

const CATEGORIES: ProcessCategory[] = ['machining', 'sintering', 'heat_treatment', 'deformation', 'additive', 'sample_prep'];
const TEST_CATEGORIES = ['nde', 'destructive', 'dynamic', 'other'] as const;
const LINEAGE_TYPES: LineageRow['type'][] = ['derived_from', 'cut_from', 'sintered_from', 'powder_from'];

// ---- small helpers ---------------------------------------------------------------------------

type Json = Record<string, any>;

/**
 * Size of the query string a request would carry, serialised the way axios does it: an array is one
 * `key[]=value` pair per element, everything percent-encoded. Conservative on purpose (the brackets are
 * encoded too), so a request under the budget is under it for any client.
 */
export function encodedQuerySize(params: Record<string, unknown>): number {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) sp.append(`${key}[]`, String(v));
    else sp.append(key, String(value));
  }
  return sp.toString().length;
}

/**
 * Splits `ids` so that each chunk's request (`build(chunk)` = its params) stays within `budget` encoded
 * bytes (spec §7 step 2; typical servers refuse a request line over 8 KB). The cost of an id is
 * measured, not assumed, so ids of any length work. At most `CHUNK` ids per request; a single id that
 * alone exceeds the budget still goes out on its own.
 */
export function chunkByBudget(ids: string[], build: (chunk: string[]) => Record<string, unknown>, budget = QUERY_BUDGET): string[][] {
  const base = encodedQuerySize(build([]));
  const out: string[][] = [];
  let current: string[] = [];
  let size = base;
  for (const id of ids) {
    // The second copy of an id costs its quotes, its separator and its encoding: the marginal cost.
    const cost = encodedQuerySize(build([id, id])) - encodedQuerySize(build([id]));
    if (current.length && (size + cost > budget || current.length >= CHUNK)) {
      out.push(current);
      current = [];
      size = base;
    }
    current.push(id);
    size += cost;
  }
  if (current.length) out.push(current);
  return out;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A record the person cannot read comes back as null or a bare id: neither is a Ref. */
function refOf(field: RelField, value: unknown): Ref | null {
  if (!value || typeof value !== 'object') return null;
  const spec: RelSpec = RELATIONS[field];
  const row = value as Json;
  const id = idOf(row[spec.id]);
  if (!id) return null;
  const code = spec.code.map((c) => str(row[c])).find((c) => c) ?? id;
  const label = spec.label ? str(row[spec.label]) : null;
  const ref: Ref = { collection: spec.collection, id, code };
  if (label && label !== code) ref.label = label;
  return ref;
}

function relationsOf(row: Json, fields: RelField[]): Record<string, Ref | null> {
  const out: Record<string, Ref | null> = {};
  for (const f of fields) out[f] = refOf(f, row[f]);
  return out;
}

function settingsOf(row: Json, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (row[f] !== null && row[f] !== undefined) out[f] = row[f];
  return out;
}

/** `force_file_id` holds a path or name as text: the Ref names the file part. */
function forceFileRef(value: unknown): Ref | null {
  const text = str(value);
  if (!text) return null;
  const name = text.split(/[\\/]/).filter(Boolean).pop() ?? text;
  return { collection: 'force_file', id: text, code: name };
}

async function getList(api: HostApi, collection: string, params: Record<string, unknown>): Promise<{ rows: Json[]; total: number | null }> {
  const { data } = await api.get(`/items/${collection}`, { params });
  const rows = (data?.data ?? []) as Json[];
  const count = data?.meta?.filter_count;
  return { rows, total: count === undefined || count === null ? null : Number(count) };
}

/** Most encoded bytes the extra relation fields may add to a request (the rest of the budget is for the ids). */
const EXTRA_BUDGET = 2500;

/** A many-to-one relation of a form that the fixed field list does not read. */
interface Extra {
  field: string;
  collection: string;
  key?: string;
}

/** What the fixed field lists already read, by root field. */
const rootsOf = (fields: string[]): Set<string> => new Set(fields.map((f) => f.split('.')[0]));
const OPERATION_ROOTS = rootsOf([...OPERATION_FIELDS, 'batch_id']);
const TEST_ROOTS = rootsOf([...TEST_FIELDS, ...SUBJECT_FIELDS, 'batch_id']);

/** The relations of a form the map has no named field for, as far as the byte budget allows (spec D6: every relation on the form). */
function extrasOf(defs: RelationDef[] | undefined, roots: Set<string>): Extra[] {
  const out: Extra[] = [];
  for (const d of defs ?? []) {
    if (d.alias || roots.has(d.field) || out.some((e) => e.field === d.field)) continue;
    const next = [...out, { field: d.field, collection: d.collection, key: d.key }];
    if (encodedQuerySize({ fields: next.map((e) => `${e.field}.*`) }) > EXTRA_BUDGET) break;
    out.push(next[next.length - 1]);
  }
  return out;
}
const extraFields = (extras: Extra[]): string[] => extras.map((e) => `${e.field}.*`);

/** `fields` of a read with the optional ones: the fixed list, then the batch, then the extra relations. */
function fieldsWith(fields: string[], { extras, batch }: Optional): string[] {
  return [...fields, ...(batch ? BATCH_FIELDS : []), ...extraFields(extras)];
}

/** Directus saying no to the request (a field the role may not read, a relation it cannot expand): 400, 403, 404. Not a 5xx or a network failure. */
const isRefusal = (e: any): boolean => [400, 403, 404].includes(e?.response?.status);

/**
 * A list read that also asks for the batch and the extra relation fields. Directus refusing them is not the map's
 * problem: the read is made again with less. First with the extras and no batch, then with the batch and no extras
 * (each optional part can be the refused one), then with the fixed fields only. Only a refusal is retried; a server
 * or network error is thrown at once.
 */
async function readList(api: HostApi, collection: string, params: Record<string, unknown>, optional: Optional): Promise<{ rows: Json[]; total: number | null }> {
  const fixed = params.fields as string[];
  const { extras, batch } = optional;
  const tiers: string[][] = [fieldsWith(fixed, optional)];
  if (batch && extras.length) tiers.push(fieldsWith(fixed, { extras, batch: false }), fieldsWith(fixed, { extras: [], batch }));
  if (batch || extras.length) tiers.push(fixed);
  for (const fields of tiers.slice(0, -1)) {
    try {
      return await getList(api, collection, { ...params, fields });
    } catch (e) {
      if (!isRefusal(e)) throw e;
    }
  }
  return getList(api, collection, { ...params, fields: tiers[tiers.length - 1] });
}

const CODE_KEYS = ['code', 'name', 'title', 'label', 'full_name', 'common_name', 'filename_download'];
/** A record of a relation the loader has no spec for: its key, and the first column that reads like a code or a name. */
function genericRef(extra: Extra, value: unknown): Ref | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Json;
  const id = idOf(row[extra.key ?? 'id']);
  if (!id) return null;
  const codeKey = Object.keys(row).find((k) => (k === 'code' || k.endsWith('_code')) && str(row[k])) ?? CODE_KEYS.find((k) => str(row[k]));
  return { collection: extra.collection, id, code: (codeKey && str(row[codeKey])) || id };
}

// ---- row mappers -----------------------------------------------------------------------------

function mapOperation(r: Json, extras: Extra[] = []): OpRow {
  const id = String(r.operation_id);
  const fast = refOf('fast_recipe_id', r.fast_recipe_id);
  const prep = refOf('source_recipe_id', r.source_recipe_id);
  const relations = relationsOf(r, OPERATION_RELATIONS);
  relations.force_file_id = forceFileRef(r.force_file_id);
  for (const e of extras) relations[e.field] = genericRef(e, r[e.field]);
  const category = CATEGORIES.includes(r.process_category) ? (r.process_category as ProcessCategory) : null;
  return {
    id,
    code: operationLabel({ pass_code: str(r.pass_code), operation_sequence: num(r.operation_sequence) }),
    methodId: idOf(r.method_id?.method_id) ?? '',
    methodName: str(r.method_id?.method_name) ?? '',
    category,
    date: str(r.operation_date),
    sequence: num(r.operation_sequence),
    // manufacturing_operations has no status column
    status: null,
    sampleId: idOf(r.sample_id),
    outputSampleId: idOf(r.output_sample_id),
    equipmentId: relations.equipment_id?.id ?? null,
    recipeKey: fast?.id ?? str(r.sintering_recipe_number) ?? prep?.id ?? null,
    batchId: batchOf(r.batch_id)?.id ?? null,
    sourceRunUid: str(r.source_run_uid),
    powderBatch: str(r.sintering_batch_number),
    relations,
    settings: settingsOf(r, OPERATION_SETTING_FIELDS),
    projectId: relations.project_id?.id ?? null,
  };
}

function mapTest(r: Json, extras: Extra[] = []): TestRow {
  const id = String(r.session_id);
  const relations = relationsOf(r, TEST_RELATIONS);
  for (const e of extras) relations[e.field] = genericRef(e, r[e.field]);
  const file = Array.isArray(r.session_data_files) ? r.session_data_files.map((j: Json) => j?.directus_files_id).find((f: Json) => f?.id) : null;
  // A test has several data files but one slot: the first is the Ref.
  relations.session_data_files = file
    ? { collection: 'directus_files', id: String(file.id), code: str(file.title) ?? str(file.filename_download) ?? String(file.id) }
    : null;

  const subjects = Array.isArray(r[SUBJECT_ALIAS])
    ? (r[SUBJECT_ALIAS] as Json[])
        .filter((s) => s?.collection === 'physical_samples')
        .map((s) => idOf(s.item && typeof s.item === 'object' ? s.item.sample_id : s.item))
        .filter((s): s is string => !!s)
    : [];
  // No junction rows (or no read of them): the primary subject is `sample_id`.
  const primary = idOf(r.sample_id);
  const subjectSampleIds = subjects.length ? subjects : primary ? [primary] : [];

  const category = (TEST_CATEGORIES as readonly string[]).includes(r.test_category) ? (r.test_category as TestRow['category']) : null;
  return {
    id,
    code: str(r.test_code) ?? str(r.test_type) ?? 'Test',
    testType: str(r.test_type),
    category,
    date: str(r.session_date),
    status: str(r.status),
    subjectSampleIds,
    equipmentId: relations.equipment_id?.id ?? null,
    batchId: batchOf(r.batch_id)?.id ?? null,
    relations,
    settings: settingsOf(r, TEST_SETTING_FIELDS),
    projectId: relations.project_id?.id ?? null,
  };
}

function mapSample(r: Json): SampleRec {
  const facts: Record<string, string> = {};
  for (const { label, field, unit } of SAMPLE_FACTS) {
    const n = num(r[field]);
    if (n !== null) facts[label] = `${n} ${unit}`;
  }
  const id = String(r.sample_id);
  const materialRef = refOf('material_id', r.material_id);
  return {
    id,
    code: str(r.sample_code) ?? id,
    form: str(r.form),
    status: str(r.current_status),
    projectId: idOf(r.project_id && typeof r.project_id === 'object' ? r.project_id.project_id : r.project_id),
    materialRef,
    facts,
  };
}

// ---- focus -----------------------------------------------------------------------------------

/** `physical_samples:<uuid>` (the `focus` query value). The legacy `?sample=<id>` is the page's concern. */
export function parseFocus(q: string | undefined): { collection: string; id: string } | null {
  const m = /^([a-z][a-z0-9_]*):([A-Za-z0-9_-]+)$/.exec(q ?? '');
  return m ? { collection: m[1], id: m[2] } : null;
}

// ---- the family of a sample ------------------------------------------------------------------

async function loadOperations(api: HostApi, ids: string[], optional: Optional, batchCodes: Record<string, string>): Promise<OpRow[]> {
  // Two single-list requests per chunk (input, output) instead of one `_or` of two lists: half the ids
  // in each query string, and each is a plain filter.
  const build = (column: string) => (chunk: string[]) => ({
    filter: JSON.stringify({ [column]: { _in: chunk } }),
    fields: OPERATION_FIELDS,
    sort: ['operation_date', 'operation_sequence'],
    limit: -1,
  });
  // The longer column name sizes the chunks for both.
  const withExtras = (column: string) => (chunk: string[]) => ({ ...build(column)(chunk), fields: fieldsWith(OPERATION_FIELDS, optional) });
  const sized = chunkByBudget(ids, withExtras('output_sample_id'));
  const pages = await Promise.all(
    sized.flatMap((chunk) => ['sample_id', 'output_sample_id'].map((column) => readList(api, 'manufacturing_operations', build(column)(chunk), optional))),
  );
  // An operation whose input is in one chunk and output in another comes back twice.
  const byId = new Map<string, OpRow>();
  for (const page of pages) {
    collectBatchCodes(page.rows, batchCodes);
    for (const row of page.rows) byId.set(String(row.operation_id), mapOperation(row, optional.extras));
  }
  return [...byId.values()];
}

/**
 * `refused`: the person may not read tests at all, so none are listed. `partial`: the subject junction could not be read, so
 * only tests whose primary sample is in the family are listed (a test on several samples, with another primary, is missing).
 * Either way the map marks "some records hidden".
 */
async function loadTests(
  api: HostApi,
  ids: string[],
  optional: Optional,
  batchCodes: Record<string, string>,
): Promise<{ tests: TestRow[]; refused: boolean; partial: boolean }> {
  const buildJunction = (chunk: string[]) => ({
    filter: JSON.stringify({
      [SUBJECT_ALIAS]: { _some: { _and: [{ collection: { _eq: 'physical_samples' } }, { item: { _in: chunk } }] } },
    }),
    fields: [...TEST_FIELDS, ...SUBJECT_FIELDS],
    sort: ['session_date'],
    limit: -1,
  });
  const buildPrimary = (chunk: string[]) => ({
    filter: JSON.stringify({ sample_id: { _in: chunk } }),
    fields: TEST_FIELDS,
    sort: ['session_date'],
    limit: -1,
  });

  let refused = false;
  let partial = false;
  const pages = await Promise.all(
    chunkByBudget(ids, (chunk) => ({ ...buildJunction(chunk), fields: fieldsWith([...TEST_FIELDS, ...SUBJECT_FIELDS], optional) })).map(async (chunk) => {
      try {
        return await readList(api, 'test_sessions', buildJunction(chunk), optional);
      } catch (e) {
        // A role that may not read the junction cannot filter on it: fall back to the primary sample.
        if (!isNotVisible(e)) throw e;
      }
      partial = true;
      try {
        return await readList(api, 'test_sessions', buildPrimary(chunk), optional);
      } catch (e) {
        if (!isNotVisible(e)) throw e;
        refused = true;
        return { rows: [] as Json[], total: null };
      }
    }),
  );
  const byId = new Map<string, TestRow>();
  for (const page of pages) {
    collectBatchCodes(page.rows, batchCodes);
    for (const row of page.rows) byId.set(String(row.session_id), mapTest(row, optional.extras));
  }
  return { tests: [...byId.values()], refused, partial };
}

/** `refused`: the person may not read genealogy; the caller marks "some records hidden". */
async function loadLineage(api: HostApi, ids: string[]): Promise<{ lineage: LineageRow[]; refused: boolean }> {
  const family = new Set(ids);
  // By child: each child belongs to exactly one chunk, so no pair is read twice or missed.
  const build = (chunk: string[]) => ({ filter: JSON.stringify({ child_sample_id: { _in: chunk } }), fields: GENEALOGY_FIELDS, limit: -1 });
  let pages: { rows: Json[] }[];
  try {
    pages = await Promise.all(chunkByBudget(ids, build).map((chunk) => getList(api, 'sample_genealogy', build(chunk))));
  } catch (e) {
    if (!isNotVisible(e)) throw e;
    return { lineage: [], refused: true };
  }
  const out: LineageRow[] = [];
  for (const page of pages) {
    for (const r of page.rows) {
      const parentId = idOf(r.parent_sample_id);
      const childId = idOf(r.child_sample_id);
      if (!parentId || !childId || !family.has(parentId)) continue;
      const type = LINEAGE_TYPES.includes(r.relationship_type) ? (r.relationship_type as LineageRow['type']) : 'derived_from';
      out.push({ parentId, childId, type, fraction: num(r.fraction) });
    }
  }
  return { lineage: out, refused: false };
}

async function loadSamples(api: HostApi, trace: TraceResponse, ids: string[]): Promise<SampleRec[]> {
  const read = new Map<string, SampleRec>();
  try {
    const build = (chunk: string[]) => ({ filter: JSON.stringify({ sample_id: { _in: chunk } }), fields: SAMPLE_FIELDS, limit: -1 });
    const pages = await Promise.all(chunkByBudget(ids, build).map((chunk) => getList(api, 'physical_samples', build(chunk))));
    for (const page of pages) for (const row of page.rows) read.set(String(row.sample_id), mapSample(row));
  } catch (e) {
    // The trace already named the family; without a read the cards carry code and form only.
    if (!isNotVisible(e)) throw e;
  }
  const fromTrace = new Map<string, { code: string | null; form: string | null }>([
    [trace.sample.sample_id, { code: trace.sample.sample_code, form: trace.sample.form }],
  ]);
  for (const r of [...trace.ancestors, ...trace.descendants]) fromTrace.set(r.sample_id, { code: r.sample_code, form: r.form });
  return ids.map(
    (id) =>
      read.get(id) ?? {
        id,
        code: fromTrace.get(id)?.code ?? id,
        form: fromTrace.get(id)?.form ?? null,
        status: null,
        projectId: null,
        materialRef: null,
        facts: {},
      },
  );
}

/**
 * The code and form of the samples that operations of the family made but that are outside it: the sibling
 * pieces of a cut, seen from one piece. Best effort: a refused read leaves them as "another piece".
 */
async function loadPieces(api: HostApi, operations: OpRow[], family: string[]): Promise<ProcessData['pieces']> {
  const inFamily = new Set(family);
  const outside = unique(operations.map((o) => o.outputSampleId).filter((id): id is string => !!id && !inFamily.has(id)));
  if (!outside.length) return undefined;
  const out: NonNullable<ProcessData['pieces']> = {};
  try {
    const build = (chunk: string[]) => ({ filter: JSON.stringify({ sample_id: { _in: chunk } }), fields: ['sample_id', 'sample_code', 'form'], limit: -1 });
    const pages = await Promise.all(chunkByBudget(outside, build).map((chunk) => getList(api, 'physical_samples', build(chunk))));
    for (const page of pages) for (const r of page.rows) out[String(r.sample_id)] = { code: str(r.sample_code) ?? String(r.sample_id), form: str(r.form) };
  } catch {
    return undefined; // a code is a nicety: the card says "another piece"
  }
  return Object.keys(out).length ? out : undefined;
}

/** Spec §7 steps 1-4 for one sample: the whole family, not just what the Reach slider will show. */
export async function loadFamily(api: HostApi, sampleId: string, defs?: FormDefs): Promise<ProcessData> {
  const trace = (await api.get(`/d1-trace/sample/${encodeURIComponent(sampleId)}`)).data as TraceResponse;
  const root = trace.sample.sample_id;
  const ids = unique([root, ...trace.ancestors.map((a) => a.sample_id), ...trace.descendants.map((d) => d.sample_id)]);

  const batchCodes: Record<string, string> = {};
  const [operations, testRead, lineageRead, samples] = await Promise.all([
    loadOperations(api, ids, { extras: extrasOf(defs?.operation, OPERATION_ROOTS), batch: hasBatch(defs?.operation) }, batchCodes),
    loadTests(api, ids, { extras: extrasOf(defs?.test, TEST_ROOTS), batch: hasBatch(defs?.test) }, batchCodes),
    loadLineage(api, ids),
    loadSamples(api, trace, ids),
  ]);
  const pieces = await loadPieces(api, operations, ids);

  const stock = new Map<string, StockOrigin>();
  for (const s of trace.stock_origins) {
    stock.set(`${s.lot_id}|${s.via_sample_id}`, {
      lotId: s.lot_id,
      lotCode: s.lot_code ?? s.lot_id,
      supplier: s.supplier_name,
      massUsedGrams: num(s.mass_used_grams),
      sampleId: s.via_sample_id,
    });
  }

  return {
    focus: { collection: 'physical_samples', id: root, code: trace.sample.sample_code ?? root, kind: 'sample' },
    samples,
    operations,
    tests: testRead.tests,
    lineage: lineageRead.lineage,
    stock: [...stock.values()],
    hidden: {
      stock: !!trace.hidden?.stock_origins,
      // A refused tests / genealogy read leaves a gap the person cannot see: mark it, do not fail the map.
      ancestors: !!trace.hidden?.ancestors || lineageRead.refused,
      descendants: !!trace.hidden?.descendants,
      events: !!trace.hidden?.events || testRead.refused || testRead.partial,
    },
    truncated: Object.values(trace.truncated ?? {}).some(Boolean),
    ...(pieces ? { pieces } : {}),
    ...(Object.keys(batchCodes).length ? { batchCodes } : {}),
  };
}

// ---- relation defs ---------------------------------------------------------------------------

/** `equipment_id` -> "Equipment", `session_data_files` -> "Session data files". */
function humanise(field: string): string {
  const text = field.replace(/_id$/, '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : field;
}

/**
 * The relations of a collection's form, read from `/relations/<c>` and `/fields/<c>`: many-to-one
 * fields and file-style many-to-many aliases, in form order, without hidden fields. `null` when the
 * role may not read them (the caller then uses `FALLBACK_RELATIONS`) or when nothing is left.
 */
export async function loadRelationDefs(api: HostApi, collection: string): Promise<RelationDef[] | null> {
  let relations: Json[];
  let fields: Json[];
  try {
    [relations, fields] = await Promise.all([
      api.get(`/relations/${collection}`).then((r) => (r.data?.data ?? []) as Json[]),
      api.get(`/fields/${collection}`).then((r) => (r.data?.data ?? []) as Json[]),
    ]);
  } catch (e) {
    if (isNotVisible(e)) return null;
    throw e;
  }

  const meta = new Map<string, Json>(fields.map((f) => [String(f.field), f.meta ?? {}]));
  const defs: (RelationDef & { sort: number })[] = [];
  const add = (field: string, target: string | null | undefined, key?: string | null, alias = false) => {
    const m = meta.get(field);
    if (!m || m.hidden || !target || defs.some((d) => d.field === field)) return;
    const label = str(Array.isArray(m.translations) ? m.translations[0]?.translation : null) ?? humanise(field);
    defs.push({ field, label, collection: target, ...(key ? { key } : {}), ...(alias ? { alias: true as const } : {}), sort: num(m.sort) ?? Number.MAX_SAFE_INTEGER });
  };

  for (const rel of relations) {
    const m = rel.meta ?? {};
    const many = m.many_collection ?? rel.collection;
    const manyField = m.many_field ?? rel.field;
    const one = m.one_collection ?? rel.related_collection;
    if (many === collection && rel.related_collection) {
      add(manyField, rel.related_collection, str(rel.schema?.foreign_key_column));
    } else if (one === collection && m.one_field && m.junction_field) {
      // A files-style alias: the target is the far side of the junction, which has its own relations.
      try {
        const far = ((await api.get(`/relations/${many}`)).data?.data ?? []) as Json[];
        const leg = far.find((r) => (r.meta?.many_field ?? r.field) === m.junction_field && (r.meta?.many_collection ?? r.collection) === many);
        add(m.one_field, leg?.related_collection ?? leg?.meta?.one_collection, null, true);
      } catch (e) {
        if (!isNotVisible(e)) throw e;
      }
    }
  }
  if (!defs.length) return null;
  return defs.sort((a, b) => a.sort - b.sort).map(({ sort: _sort, ...def }) => def);
}

// ---- used-in fans (spec D20) -----------------------------------------------------------------

export interface UsedIn {
  items: OpRow[] | TestRow[] | SampleRec[];
  /** `meta.filter_count` of the main list: "+N more" is `total - 20 * page`. */
  total: number;
  /** Equipment and insert edges: the tests that used them (same page), and how many there are. */
  tests?: TestRow[];
  testsTotal?: number;
}

/** Collections that fan into operations (and tests) through one column. */
const OPERATION_FAN: Record<string, { column: string; tests: boolean }> = {
  tools: { column: 'tool_id', tests: false },
  equipment: { column: 'equipment_id', tests: true },
  insert_edges: { column: 'insert_edge_id', tests: true },
  fast_recipes: { column: 'fast_recipe_id', tests: false },
  prep_recipes: { column: 'source_recipe_id', tests: false },
};

/** Collections that fan into samples through a filter on `physical_samples`. */
const SAMPLE_FAN: Record<string, (id: string) => Json> = {
  materials: (id) => ({ material_id: { _eq: id } }),
  projects: (id) => ({ project_id: { _eq: id } }),
};

/**
 * One page (`page` is 1-based, 20 rows) of what used a record. Operations and tests come newest first;
 * a stock lot is read through `sample_stock_provenance`: one page of its samples, then the operations that
 * made them (`output_sample_id`), so `total` counts samples and a page may hold fewer operations.
 */
export async function loadUsedIn(api: HostApi, ref: { collection: string; id: string }, page: number): Promise<UsedIn> {
  const p = Math.max(1, Math.floor(page) || 1);
  const paged = { limit: FAN_PAGE, page: p, meta: 'filter_count' };
  const opParams = (filter: Json) => ({ filter: JSON.stringify(filter), fields: OPERATION_FIELDS, sort: ['-operation_date'], ...paged });

  const fan = OPERATION_FAN[ref.collection];
  if (fan) {
    const filter = { [fan.column]: { _eq: ref.id } };
    const [ops, tests] = await Promise.all([
      getList(api, 'manufacturing_operations', opParams(filter)),
      fan.tests
        ? getList(api, 'test_sessions', { filter: JSON.stringify(filter), fields: TEST_FIELDS, sort: ['-session_date'], ...paged })
        : Promise.resolve(null),
    ]);
    const result: UsedIn = { items: ops.rows.map((r) => mapOperation(r)), total: ops.total ?? ops.rows.length };
    if (tests) {
      result.tests = tests.rows.map((r) => mapTest(r));
      result.testsTotal = tests.total ?? tests.rows.length;
    }
    return result;
  }

  if (ref.collection === 'campaigns') {
    // Through the campaign_samples junction (as the Sample page reads it), not an alias filter on samples.
    const res = await getList(api, 'campaign_samples', {
      filter: JSON.stringify({ campaign_id: { _eq: ref.id } }),
      fields: SAMPLE_FIELDS.map((f) => `sample_id.${f}`),
      sort: ['sample_id.sample_code'],
      ...paged,
    });
    // A sample the person may not read comes back null: no card, and no count of them.
    const items = res.rows.map((r) => r.sample_id).filter((s): s is Json => !!s && typeof s === 'object').map(mapSample);
    return { items, total: res.total ?? items.length };
  }

  const sampleFilter = SAMPLE_FAN[ref.collection];
  if (sampleFilter) {
    const res = await getList(api, 'physical_samples', {
      filter: JSON.stringify(sampleFilter(ref.id)),
      fields: SAMPLE_FIELDS,
      sort: ['-created_at'],
      ...paged,
    });
    return { items: res.rows.map(mapSample), total: res.total ?? res.rows.length };
  }

  if (ref.collection === 'raw_stock_lots') {
    const prov = await getList(api, 'sample_stock_provenance', {
      filter: JSON.stringify({ lot_id: { _eq: ref.id } }),
      fields: ['sample_id'],
      sort: ['-created_at'],
      ...paged,
    });
    const sampleIds = unique(prov.rows.map((r) => idOf(r.sample_id)).filter((s): s is string => !!s));
    const total = prov.total ?? sampleIds.length;
    if (!sampleIds.length) return { items: [], total };
    const ops = await getList(api, 'manufacturing_operations', {
      filter: JSON.stringify({ output_sample_id: { _in: sampleIds } }),
      fields: OPERATION_FIELDS,
      sort: ['-operation_date'],
      limit: -1,
    });
    return { items: ops.rows.map((r) => mapOperation(r)), total };
  }

  throw new Error(`No used-in fan for ${ref.collection}`);
}

// ---- the record a fan or a focused step starts from (spec D20) -----------------------------------

/** What names a record that has no page of its own: table key, code columns, label column. */
const RECORD_SPECS: Record<string, RelSpec> = {
  ...Object.fromEntries(Object.values(RELATIONS).map((spec) => [spec.collection, spec as RelSpec])),
  raw_stock_lots: { collection: 'raw_stock_lots', id: 'lot_id', code: ['lot_code'], label: 'supplier_name' },
};

/**
 * The code (and name) of a record, for the card a used-in fan hangs from. Throws what the API threw, so
 * a 403 / 404 reads as "not visible" to the caller (`isNotVisible`).
 */
export async function loadRecordRef(api: HostApi, ref: { collection: string; id: string }): Promise<Ref> {
  const spec = RECORD_SPECS[ref.collection];
  if (!spec) throw new Error(`The Process map cannot name ${ref.collection}`);
  const fields = unique([spec.id, ...spec.code, ...(spec.label ? [spec.label] : [])]);
  const { data } = await api.get(`/items/${ref.collection}/${encodeURIComponent(ref.id)}`, { params: { fields } });
  const row = (data?.data ?? null) as Json | null;
  const id = row ? idOf(row[spec.id]) : null;
  if (!row || !id) throw Object.assign(new Error('Record not found'), { response: { status: 404 } });
  const code = spec.code.map((c) => str(row[c])).find((c) => c) ?? id;
  const label = spec.label ? str(row[spec.label]) : null;
  return label && label !== code ? { collection: ref.collection, id, code, label } : { collection: ref.collection, id, code };
}

/** The sample whose family stands for an operation or test: an operation's input (else its output), a test's first subject. */
export const sampleOfRow = (row: OpRow | TestRow): string | null =>
  'subjectSampleIds' in row ? (row.subjectSampleIds[0] ?? null) : (row.sampleId ?? row.outputSampleId);

/** Reads the operation or test an Operation / Test focus names, as the loader maps it. Throws like `loadRecordRef`. */
export async function loadStepRow(api: HostApi, ref: { collection: string; id: string }): Promise<OpRow | TestRow> {
  const id = encodeURIComponent(ref.id);
  if (ref.collection === 'manufacturing_operations') {
    const { data } = await api.get(`/items/manufacturing_operations/${id}`, { params: { fields: OPERATION_FIELDS } });
    if (!data?.data) throw Object.assign(new Error('Record not found'), { response: { status: 404 } });
    return mapOperation(data.data as Json);
  }
  if (ref.collection === 'test_sessions') {
    let res;
    try {
      res = await api.get(`/items/test_sessions/${id}`, { params: { fields: [...TEST_FIELDS, ...SUBJECT_FIELDS] } });
    } catch (e) {
      // A role that may not read the subject junction still reads the test's own sample.
      if (!isNotVisible(e)) throw e;
      res = await api.get(`/items/test_sessions/${id}`, { params: { fields: TEST_FIELDS } });
    }
    if (!res.data?.data) throw Object.assign(new Error('Record not found'), { response: { status: 404 } });
    return mapTest(res.data.data as Json);
  }
  throw new Error(`${ref.collection} is not an operation or a test`);
}
