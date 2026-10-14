// The Process map's loader of a sample's family, through `HostApi` only, so the signed-in person's permissions
// apply and no Directus SDK is imported (`hostNeutral` guard). The other loaders: `loadFans.ts` (used-in fans, the
// record a fan or a step starts from); `requests.ts` and `rows.ts` are what both are made of.
//
//   loadFamily       a sample's whole family: trace, operations, tests, genealogy, samples
//   loadRelationDefs the relations of a form, read at runtime for the Inside tray (null when refused)

import { isNotVisible, type HostApi, type TraceResponse } from '@d1/ui';
import { type RelationDef } from './formSlots';
import { chunkByBudget, extrasOf, fieldsWith, getList, hasBatch, readList, rootsOf, type Json, type Optional } from './requests';
import {
  OPERATION_FIELDS,
  SAMPLE_FIELDS,
  SUBJECT_ALIAS,
  SUBJECT_FIELDS,
  TEST_FIELDS,
  collectBatchCodes,
  idOf,
  mapOperation,
  mapSample,
  mapTest,
  num,
  str,
  unique,
} from './rows';
import type { LineageRow, OpRow, ProcessData, SampleRec, StockOrigin, TestRow } from './types';

/** The relations of the two forms, as `loadRelationDefs` read them at runtime. */
export interface FormDefs {
  operation: RelationDef[];
  test: RelationDef[];
}

const GENEALOGY_FIELDS = ['child_sample_id', 'parent_sample_id', 'relationship_type', 'fraction'];
const LINEAGE_TYPES: LineageRow['type'][] = ['derived_from', 'cut_from', 'sintered_from', 'powder_from'];

/** What the fixed field lists already read, by root field. */
const OPERATION_ROOTS = rootsOf([...OPERATION_FIELDS, 'batch_id']);
const TEST_ROOTS = rootsOf([...TEST_FIELDS, ...SUBJECT_FIELDS, 'batch_id']);

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
