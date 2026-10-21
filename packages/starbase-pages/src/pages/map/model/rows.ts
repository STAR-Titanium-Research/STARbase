// The fields the Process map reads of each collection, and the mappers from a row as the API returns it to the
// map's own types (OpRow, TestRow, SampleRec, Ref). Shared by `loadFamily` and `loadFans`; no Vue, no I/O.

import { operationLabel } from '@d1/ui';
import { KEY_SETTING_FIELDS } from './formSlots';
import type { Extra, Json } from './requests';
import type { OpRow, ProcessCategory, Ref, SampleRec, TestRow } from './types';

export interface RelSpec {
  collection: string;
  /** Primary key of the target collection. */
  id: string;
  /** First non-empty wins as the Ref's `code`. */
  code: string[];
  /** Shown as the Ref's `label` when it differs from the code. */
  label?: string;
}

export const RELATIONS = {
  // A machine reads by its name ("RDC Water Jet Cutter"), not its six-character code; the code is the label.
  equipment_id: { collection: 'equipment', id: 'equipment_id', code: ['equipment_name', 'equipment_code'], label: 'equipment_code' },
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

export const unique = (xs: string[]): string[] => [...new Set(xs)];

/** Inline setting fields of the key settings (formSlots.KEY_SETTING_FIELDS); `test_type` is its own column. */
const settingFields = (categories: (keyof typeof KEY_SETTING_FIELDS)[]): string[] =>
  unique(
    categories.flatMap((c) => KEY_SETTING_FIELDS[c].flatMap((d) => d.fields.map((f) => f.field))).filter((f) => f !== 'test_type'),
  );

const OPERATION_SETTING_FIELDS = settingFields(['sintering', 'conform', 'machining', 'heat_treatment', 'additive', 'deformation']);
const TEST_SETTING_FIELDS = settingFields(['test']);

export const OPERATION_FIELDS = [
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

export const TEST_FIELDS = [
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
export function collectBatchCodes(rows: Json[], codes: Record<string, string>): void {
  for (const row of rows) {
    const batch = batchOf(row.batch_id);
    if (batch?.code) codes[batch.id] = batch.code;
  }
}

// Subjects of a test: the M2A junction `test_sessions_subject(test_sessions_id, collection, item)`, whose
// alias on `test_sessions` is `subject` (db/migrations/20260703000064_test_subject_directus_meta.sql:
// `directus_fields` row, collection test_sessions, field `subject`, special m2a).
export const SUBJECT_ALIAS = 'subject';
export const SUBJECT_FIELDS = [`${SUBJECT_ALIAS}.collection`, `${SUBJECT_ALIAS}.item`];

export const SAMPLE_FIELDS = [
  'sample_id',
  'sample_code',
  'nickname',
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

const CATEGORIES: ProcessCategory[] = ['machining', 'sintering', 'conform', 'heat_treatment', 'deformation', 'additive', 'sample_prep'];
const TEST_CATEGORIES = ['nde', 'destructive', 'dynamic', 'other'] as const;

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
export const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
export const num = (v: unknown): number | null => {
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

/**
 * Planned work (ADR-0019) of a row as read. Only a row that says `planned` is planned: without the field (not asked for,
 * or a database without the migration) a record is done, which is what every record was before the column existed.
 */
function workOf(r: Json): { workState?: 'planned'; plannedDate?: string | null } {
  if (r.work_state !== 'planned') return {};
  return { workState: 'planned', plannedDate: str(r.planned_date) };
}

export function mapOperation(r: Json, extras: Extra[] = []): OpRow {
  const id = String(r.operation_id);
  const fast = refOf('fast_recipe_id', r.fast_recipe_id);
  const prep = refOf('source_recipe_id', r.source_recipe_id);
  const relations = relationsOf(r, OPERATION_RELATIONS);
  relations.force_file_id = forceFileRef(r.force_file_id);
  for (const e of extras) relations[e.field] = genericRef(e, r[e.field]);
  const category = CATEGORIES.includes(r.process_category) ? (r.process_category as ProcessCategory) : null;
  const work = workOf(r);
  return {
    id,
    code: operationLabel({ pass_code: str(r.pass_code), operation_sequence: num(r.operation_sequence) }),
    methodId: idOf(r.method_id?.method_id) ?? '',
    methodName: str(r.method_id?.method_name) ?? '',
    category,
    // A planned operation has no operation date: the day it is meant to happen stands in, so it sorts and reads as one.
    date: str(r.operation_date) ?? (work.plannedDate ?? null),
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
    ...work,
  };
}

export function mapTest(r: Json, extras: Extra[] = []): TestRow {
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
  const work = workOf(r);
  return {
    id,
    code: str(r.test_code) ?? str(r.test_type) ?? 'Test',
    testType: str(r.test_type),
    category,
    date: str(r.session_date) ?? (work.plannedDate ?? null),
    status: str(r.status),
    subjectSampleIds,
    equipmentId: relations.equipment_id?.id ?? null,
    batchId: batchOf(r.batch_id)?.id ?? null,
    relations,
    settings: settingsOf(r, TEST_SETTING_FIELDS),
    projectId: relations.project_id?.id ?? null,
    ...work,
  };
}

export function mapSample(r: Json): SampleRec {
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
    nickname: str(r.nickname),
    form: str(r.form),
    status: str(r.current_status),
    projectId: idOf(r.project_id && typeof r.project_id === 'object' ? r.project_id.project_id : r.project_id),
    materialRef,
    facts,
  };
}
