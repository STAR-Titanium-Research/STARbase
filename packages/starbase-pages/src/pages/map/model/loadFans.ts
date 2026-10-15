// The used-in fans (spec D20) and the records they start from: what used a tool, machine, edge, recipe, stock lot,
// material, project or campaign, the code of that record, and the operation or test a step focus names.
// Through `HostApi` only, like the rest of the loaders.

import { isNotVisible, type HostApi } from '@d1/ui';
import { OPERATION_FIELDS, RELATIONS, SAMPLE_FIELDS, SUBJECT_FIELDS, TEST_FIELDS, idOf, mapOperation, mapSample, mapTest, str, unique, type RelSpec } from './rows';
import { getList, isRefusal, type Json } from './requests';
import type { OpRow, Ref, SampleRec, TestRow } from './types';

/** Rows per used-in page (spec D20). */
export const FAN_PAGE = 20;

// ---- used-in fans (spec D20) -----------------------------------------------------------------

export interface UsedIn {
  items: OpRow[] | TestRow[] | SampleRec[];
  /**
   * `meta.filter_count` of the main list: "+N more" is `total - 20 * page`. Null where the count comes from a junction or
   * provenance table whose rows the person may not read through the target (campaign samples, stock-lot provenance):
   * that count would include hidden records, so no number is passed on (spec D21) and `more` says if a next page exists.
   */
  total: number | null;
  /** With a null `total`: the junction page came back full, so another page may exist. */
  more?: boolean;
  /** A junction or provenance row on this page has a sample the person may not read (it came back null): spec D21, a marker only. */
  hidden?: boolean;
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

/** The sample id of a provenance row: nested (`{ sample_id }`) or bare; null when the person may not read the sample. */
const sampleIdOf = (v: unknown): string | null => idOf(v && typeof v === 'object' ? (v as Json).sample_id : v);

/**
 * One page (`page` is 1-based, 20 rows) of what used a record. Operations and tests come newest first;
 * a stock lot is read through `sample_stock_provenance`: one page of its samples, then the operations that
 * made them (`output_sample_id`), so a page may hold fewer operations than samples (and none at all).
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
    const junction = { filter: JSON.stringify({ campaign_id: { _eq: ref.id } }), ...paged };
    let res: { rows: Json[] };
    try {
      res = await getList(api, 'campaign_samples', { ...junction, fields: SAMPLE_FIELDS.map((f) => `sample_id.${f}`), sort: ['sample_id.sample_code'] });
    } catch (e) {
      if (!isRefusal(e)) throw e;
      // A role that reads the junction but not the samples: bare ids, enough to page; no card can be drawn, so it is all "hidden".
      res = await getList(api, 'campaign_samples', { ...junction, fields: ['sample_id'], sort: ['campaign_id'] });
      return { items: [], total: null, more: res.rows.length >= FAN_PAGE, hidden: true };
    }
    // A sample the person may not read comes back null: no card, and no count of them. The junction's count includes
    // them, so it is not passed on: paging goes on until a page comes back short.
    const samples = res.rows.map((r) => r.sample_id);
    const items = samples.filter((s): s is Json => !!s && typeof s === 'object').map(mapSample);
    return { items, total: null, more: res.rows.length >= FAN_PAGE, ...(items.length < samples.length ? { hidden: true } : {}) };
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
    const provenance = { filter: JSON.stringify({ lot_id: { _eq: ref.id } }), sort: ['-created_at'], ...paged };
    let prov: { rows: Json[] };
    let refused = false;
    try {
      // Nested, so a sample the person may not read comes back null (a bare id would hide that).
      prov = await getList(api, 'sample_stock_provenance', { ...provenance, fields: ['sample_id.sample_id'] });
    } catch (e) {
      if (!isRefusal(e)) throw e;
      // A role that reads the provenance but not the samples: bare ids still feed the operations read, but what they are stays unseen.
      refused = true;
      prov = await getList(api, 'sample_stock_provenance', { ...provenance, fields: ['sample_id'] });
    }
    const readable = prov.rows.map((r) => sampleIdOf(r.sample_id));
    const sampleIds = unique(readable.filter((s): s is string => !!s));
    const hidden = refused || readable.some((s) => !s);
    // As for a campaign: the provenance count includes samples the person may not read, so only "is there a next page".
    const more = prov.rows.length >= FAN_PAGE;
    if (!sampleIds.length) return { items: [], total: null, more, ...(hidden ? { hidden } : {}) };
    const ops = await getList(api, 'manufacturing_operations', {
      filter: JSON.stringify({ output_sample_id: { _in: sampleIds } }),
      fields: OPERATION_FIELDS,
      sort: ['-operation_date'],
      limit: -1,
    });
    return { items: ops.rows.map((r) => mapOperation(r)), total: null, more, ...(hidden ? { hidden } : {}) };
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
