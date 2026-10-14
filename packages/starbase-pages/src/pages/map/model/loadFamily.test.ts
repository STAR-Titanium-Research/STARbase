import { describe, expect, it } from 'vitest';
import type { HostApi, TraceResponse } from '@d1/ui';
import { isNotVisible } from '@d1/ui';
import { chunkByBudget, encodedQuerySize, loadFamily, loadRecordRef, loadRelationDefs, loadStepRow, loadUsedIn, parseFocus, sampleOfRow } from './loadFamily';

interface Call {
  path: string;
  params: Record<string, any>;
}

type Handler = (path: string, params: Record<string, any>) => unknown;

/** A fake HostApi that records every GET and answers from `handler` (a returned Error rejects). */
function fakeApi(handler: Handler): { api: HostApi; calls: Call[] } {
  const calls: Call[] = [];
  const api = {
    get: async (path: string, config?: { params?: Record<string, unknown> }) => {
      const params = (config?.params ?? {}) as Record<string, any>;
      calls.push({ path, params });
      const out = handler(path, params);
      if (out instanceof Error) throw out;
      return { data: out };
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    delete: async () => ({ data: {} }),
  } as unknown as HostApi;
  return { api, calls };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const filterOf = (c: Call) => JSON.parse(c.params.filter as string);

function trace(p: Partial<TraceResponse> = {}): TraceResponse {
  return {
    sample: { sample_id: 'root', sample_code: 'S-ROOT', form: 'disc' },
    stock_origins: [],
    ancestors: [],
    descendants: [],
    events: [],
    hidden: { stock_origins: false, ancestors: false, events: false, descendants: false },
    truncated: {},
    ...p,
  };
}

const relative = (id: string, depth = 1) => ({
  depth,
  sample_id: id,
  sample_code: id.toUpperCase(),
  form: null,
  relationship_type: 'cut_from',
  fraction: null,
  through_hidden: false,
});

/** Answers the trace and returns an empty list for every other read. */
const emptyLists = (t: TraceResponse): Handler => (path) => {
  if (path.startsWith('/d1-trace/')) return t;
  return { data: [], meta: { filter_count: 0 } };
};

describe('parseFocus', () => {
  it('reads collection:id and rejects the rest', () => {
    expect(parseFocus('physical_samples:abc-123')).toEqual({ collection: 'physical_samples', id: 'abc-123' });
    expect(parseFocus(undefined)).toBeNull();
    expect(parseFocus('')).toBeNull();
    expect(parseFocus('physical_samples')).toBeNull();
    expect(parseFocus('physical_samples:')).toBeNull();
    expect(parseFocus('a:b:c')).toBeNull();
  });
});

describe('loadFamily', () => {
  it('keeps every request of 320 family ids within 6000 encoded bytes and covers every id', async () => {
    const ids = Array.from({ length: 319 }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`);
    const t = trace({ descendants: ids.map((id) => relative(id)) });
    const { api, calls } = fakeApi(emptyLists(t));
    await loadFamily(api, 'root');

    const family = ['root', ...ids];
    // The query string axios would send: arrays as key[]=v pairs, all percent-encoded.
    const encoded = (c: Call) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(c.params)) {
        if (Array.isArray(v)) v.forEach((x) => sp.append(`${k}[]`, String(x)));
        else sp.append(k, String(v));
      }
      return sp.toString().length;
    };
    const lists = (c: Call): string[] => {
      const find = (o: any): string[] | null => {
        if (Array.isArray(o)) {
          for (const x of o) {
            const r = find(x);
            if (r) return r;
          }
          return null;
        }
        if (o && typeof o === 'object') {
          if (Array.isArray(o._in)) return o._in;
          for (const x of Object.values(o)) {
            const r = find(x);
            if (r) return r;
          }
        }
        return null;
      };
      return find(filterOf(c)) ?? [];
    };

    for (const path of ['/items/manufacturing_operations', '/items/test_sessions', '/items/sample_genealogy', '/items/physical_samples']) {
      const reqs = calls.filter((c) => c.path === path);
      expect(reqs.length).toBeGreaterThan(1);
      for (const c of reqs) expect(encoded(c)).toBeLessThanOrEqual(6000);
    }
    const ops = calls.filter((c) => c.path === '/items/manufacturing_operations');
    for (const column of ['sample_id', 'output_sample_id']) {
      const sent = ops.filter((c) => Object.keys(filterOf(c))[0] === column);
      expect(sent.flatMap(lists).sort()).toEqual([...family].sort());
    }
    for (const path of ['/items/test_sessions', '/items/sample_genealogy', '/items/physical_samples']) {
      expect(calls.filter((c) => c.path === path).flatMap(lists).sort()).toEqual([...family].sort());
    }
  });

  it('sizes chunks by the measured cost of an id', () => {
    const build = (chunk: string[]) => ({ filter: JSON.stringify({ x: { _in: chunk } }) });
    const long = Array.from({ length: 100 }, (_, i) => `id-${i}-${'z'.repeat(200)}`);
    const out = chunkByBudget(long, build, 3000);
    expect(out.flat()).toEqual(long);
    for (const c of out) expect(encodedQuerySize(build(c))).toBeLessThanOrEqual(3000);
    // a lone id over budget still goes out
    expect(chunkByBudget(['q'.repeat(5000)], build, 3000)).toHaveLength(1);
    expect(chunkByBudget([], build)).toEqual([]);
  });

  it('asks for ops by sample_id and by output_sample_id', async () => {
    const { api, calls } = fakeApi(emptyLists(trace({ ancestors: [relative('p1')] })));
    await loadFamily(api, 'root');
    const reqs = calls.filter((c) => c.path === '/items/manufacturing_operations');
    // two single-list requests, no _or
    expect(reqs.map(filterOf)).toEqual([
      { sample_id: { _in: ['root', 'p1'] } },
      { output_sample_id: { _in: ['root', 'p1'] } },
    ]);
    const call = reqs[0];
    expect(call.params.limit).toBe(-1);
    expect(call.params.fields).toContain('sintering_batch_number');
    // slice 2 adds batch_id; asking for it now would refuse the whole read
    expect(call.params.fields).not.toContain('batch_id');
  });

  it('asks for tests through the subject junction of physical samples', async () => {
    const { api, calls } = fakeApi(emptyLists(trace()));
    await loadFamily(api, 'root');
    const call = calls.find((c) => c.path === '/items/test_sessions')!;
    expect(filterOf(call)).toEqual({
      subject: { _some: { _and: [{ collection: { _eq: 'physical_samples' } }, { item: { _in: ['root'] } }] } },
    });
  });

  it('maps trace hidden booleans and numbers to booleans', async () => {
    const t = trace({ hidden: { stock_origins: 2, ancestors: true, events: 0, descendants: false } });
    const { api } = fakeApi(emptyLists(t));
    const data = await loadFamily(api, 'root');
    expect(data.hidden).toEqual({ stock: true, ancestors: true, events: false, descendants: false });
  });

  it('truncated when any trace list is truncated', async () => {
    const a = await loadFamily(fakeApi(emptyLists(trace({ truncated: { events: false, ancestors: false } }))).api, 'root');
    expect(a.truncated).toBe(false);
    const b = await loadFamily(fakeApi(emptyLists(trace({ truncated: { events: false, descendants: true } }))).api, 'root');
    expect(b.truncated).toBe(true);
  });

  it('a 404 from d1-trace rejects with isNotVisible(err) true', async () => {
    const { api } = fakeApi((path) => (path.startsWith('/d1-trace/') ? httpError(404) : { data: [] }));
    const err = await loadFamily(api, 'root').then(
      () => null,
      (e) => e,
    );
    expect(err).not.toBeNull();
    expect(isNotVisible(err)).toBe(true);
  });

  it('builds the focus, stock origins and lineage among family ids only', async () => {
    const t = trace({
      ancestors: [relative('p1')],
      stock_origins: [
        {
          lot_id: 'L1',
          lot_code: 'LOT-1',
          stock_type: 'powder',
          supplier_name: 'Acme',
          mass_used_grams: 12.5,
          via_sample_id: 'p1',
          via_sample_code: 'P1',
          depth: 1,
          through_hidden: false,
        },
      ],
    });
    const { api, calls } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return t;
      if (path === '/items/sample_genealogy') {
        return {
          data: [
            { child_sample_id: 'root', parent_sample_id: 'p1', relationship_type: 'cut_from', fraction: '0.5' },
            { child_sample_id: 'root', parent_sample_id: 'outsider', relationship_type: 'derived_from', fraction: null },
          ],
        };
      }
      return { data: [], meta: { filter_count: 0 } };
    });
    const data = await loadFamily(api, 'root');
    expect(data.focus).toEqual({ collection: 'physical_samples', id: 'root', code: 'S-ROOT', kind: 'sample' });
    expect(data.lineage).toEqual([{ parentId: 'p1', childId: 'root', type: 'cut_from', fraction: 0.5 }]);
    expect(data.stock).toEqual([{ lotId: 'L1', lotCode: 'LOT-1', supplier: 'Acme', massUsedGrams: 12.5, sampleId: 'p1' }]);
    // stock comes from the trace, not from sample_stock_provenance
    expect(calls.some((c) => c.path === '/items/sample_stock_provenance')).toBe(false);
  });

  it('maps a sample record, falling back to the trace when the sample read is refused', async () => {
    const t = trace({ ancestors: [relative('p1')] });
    const ok = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return t;
      if (path === '/items/physical_samples') {
        return {
          data: [
            {
              sample_id: 'root',
              sample_code: 'S-ROOT',
              form: 'disc',
              current_status: 'active',
              mass_grams: '12.5',
              diameter_mm: 20,
              project_id: { project_id: 'p9', project_code: 'PRJ', project_name: 'Project' },
              material_id: { material_id: 'm1', common_name: 'Ti-6Al-4V', alloy_code: 'Ti64' },
            },
          ],
        };
      }
      return { data: [] };
    });
    const withRead = await loadFamily(ok.api, 'root');
    const root = withRead.samples.find((s) => s.id === 'root')!;
    expect(root).toMatchObject({ code: 'S-ROOT', form: 'disc', status: 'active', projectId: 'p9' });
    expect(root.materialRef).toEqual({ collection: 'materials', id: 'm1', code: 'Ti64', label: 'Ti-6Al-4V' });
    expect(root.facts).toEqual({ Mass: '12.5 g', Diameter: '20 mm' });
    // a family member the read did not return is still a card, from the trace
    expect(withRead.samples.find((s) => s.id === 'p1')).toMatchObject({ code: 'P1' });

    const refused = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return t;
      if (path === '/items/physical_samples') return httpError(403);
      return { data: [] };
    });
    const fallback = await loadFamily(refused.api, 'root');
    expect(fallback.samples.map((s) => s.id).sort()).toEqual(['p1', 'root']);
  });

  it('maps an operation row: refs, recipe key, powder batch, force file, settings', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/manufacturing_operations') {
        return {
          data: [
            {
              operation_id: 'o1',
              pass_code: 'MF-1',
              operation_sequence: 3,
              operation_date: '2026-01-02T00:00:00Z',
              process_category: 'sintering',
              sample_id: 'root',
              output_sample_id: 'out',
              source_run_uid: 'u1',
              sintering_batch_number: 'TIMET 45-150',
              force_file_id: 'C:\\force\\run7.mat',
              sintering_max_temp_celsius: 1200,
              sintering_max_force_kn: null,
              method_id: { method_id: 'm1', method_name: 'FAST' },
              equipment_id: { equipment_id: 'e1', equipment_code: 'FAST25', equipment_name: 'FAST 25' },
              fast_recipe_id: { id: 'fr1', name: 'Recipe A' },
              source_recipe_id: null,
              project_id: { project_id: 'p1', project_code: 'PRJ', project_name: 'Project' },
              tool_id: null,
            },
          ],
        };
      }
      return { data: [] };
    });
    const [op] = (await loadFamily(api, 'root')).operations;
    expect(op).toMatchObject({
      id: 'o1',
      code: 'MF-1',
      methodId: 'm1',
      methodName: 'FAST',
      category: 'sintering',
      date: '2026-01-02T00:00:00Z',
      sequence: 3,
      status: null,
      sampleId: 'root',
      outputSampleId: 'out',
      equipmentId: 'e1',
      recipeKey: 'fr1',
      batchId: null,
      sourceRunUid: 'u1',
      powderBatch: 'TIMET 45-150',
      projectId: 'p1',
    });
    expect(op.relations.equipment_id).toEqual({ collection: 'equipment', id: 'e1', code: 'FAST25', label: 'FAST 25' });
    expect(op.relations.fast_recipe_id).toMatchObject({ collection: 'fast_recipes', id: 'fr1', code: 'Recipe A' });
    expect(op.relations.force_file_id).toEqual({ collection: 'force_file', id: 'C:\\force\\run7.mat', code: 'run7.mat' });
    expect(op.relations.tool_id).toBeNull();
    // null settings are dropped
    expect(op.settings).toEqual({ sintering_max_temp_celsius: 1200 });
  });

  it('recipeKey falls back to the prep recipe, then to nothing', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/manufacturing_operations') {
        return {
          data: [
            { operation_id: 'a', process_category: 'sample_prep', source_recipe_id: { recipe_id: 'pr1', name: 'Polish' } },
            { operation_id: 'b', process_category: 'machining' },
          ],
        };
      }
      return { data: [] };
    });
    const ops = (await loadFamily(api, 'root')).operations;
    expect(ops.find((o) => o.id === 'a')!.recipeKey).toBe('pr1');
    expect(ops.find((o) => o.id === 'b')!.recipeKey).toBeNull();
    expect(ops.find((o) => o.id === 'b')!.relations.force_file_id).toBeNull();
  });

  it('maps a test row: subjects from the junction (physical samples only) and data file', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/test_sessions') {
        return {
          data: [
            {
              session_id: 't1',
              sample_id: 'root',
              test_type: 'tensile',
              test_category: 'destructive',
              session_date: '2026-02-01',
              status: 'complete',
              subject: [
                { collection: 'physical_samples', item: 'root' },
                { collection: 'insert_edges', item: 'ie1' },
              ],
              session_data_files: [{ directus_files_id: { id: 'f1', title: null, filename_download: 'curve.csv' } }],
              equipment_id: { equipment_id: 'e9', equipment_code: 'INS', equipment_name: 'Instron' },
              tensile_uts_mpa: 900,
            },
          ],
        };
      }
      return { data: [] };
    });
    const [test] = (await loadFamily(api, 'root')).tests;
    expect(test).toMatchObject({
      id: 't1',
      testType: 'tensile',
      category: 'destructive',
      subjectSampleIds: ['root'],
      equipmentId: 'e9',
      status: 'complete',
      batchId: null,
      settings: { tensile_uts_mpa: 900 },
    });
    expect(test.relations.session_data_files).toEqual({ collection: 'directus_files', id: 'f1', code: 'curve.csv' });
  });

  it('falls back to the primary sample when the subject junction cannot be filtered', async () => {
    const { api, calls } = fakeApi((path, params) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/test_sessions') {
        if (String(params.filter).includes('subject')) return httpError(403);
        return { data: [{ session_id: 't1', sample_id: 'root', test_category: 'nde' }] };
      }
      return { data: [] };
    });
    const data = await loadFamily(api, 'root');
    expect(data.tests[0].subjectSampleIds).toEqual(['root']);
    const retry = calls.filter((c) => c.path === '/items/test_sessions').at(-1)!;
    expect(filterOf(retry)).toEqual({ sample_id: { _in: ['root'] } });
    expect(retry.params.fields).not.toContain('subject.item');
  });

  it('merges one operation seen in two chunks once', async () => {
    const t = trace({ descendants: Array.from({ length: 200 }, (_, i) => relative(`d${i}`)) });
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return t;
      if (path === '/items/manufacturing_operations') {
        return { data: [{ operation_id: 'same', method_id: { method_id: 'm', method_name: 'M' }, process_category: 'machining' }] };
      }
      return { data: [] };
    });
    expect((await loadFamily(api, 'root')).operations).toHaveLength(1);
  });
});

describe('loadFamily degradations', () => {
  it('a refused tests read leaves no tests and marks events hidden', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/test_sessions') return httpError(403);
      return { data: [{ operation_id: 'o1', process_category: 'machining' }] };
    });
    const data = await loadFamily(api, 'root');
    expect(data.tests).toEqual([]);
    expect(data.hidden.events).toBe(true);
    expect(data.operations).toHaveLength(1);
  });

  it('a refused genealogy read leaves no lineage and marks ancestors hidden', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/sample_genealogy') return httpError(403);
      return { data: [] };
    });
    const data = await loadFamily(api, 'root');
    expect(data.lineage).toEqual([]);
    expect(data.hidden.ancestors).toBe(true);
  });

  it('a refused operations read still rejects', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/manufacturing_operations') return httpError(403);
      return { data: [] };
    });
    await expect(loadFamily(api, 'root')).rejects.toMatchObject({ response: { status: 403 } });
  });

  it('a server error on tests still rejects', async () => {
    const { api } = fakeApi((path) => {
      if (path.startsWith('/d1-trace/')) return trace();
      if (path === '/items/test_sessions') return httpError(500);
      return { data: [] };
    });
    await expect(loadFamily(api, 'root')).rejects.toMatchObject({ response: { status: 500 } });
  });
});

describe('loadRelationDefs', () => {
  it('derives defs from relations and fields, skipping hidden fields and relations from other collections', async () => {
    const { api } = fakeApi((path) => {
      if (path === '/relations/manufacturing_operations') {
        return {
          data: [
            { collection: 'manufacturing_operations', field: 'tool_id', related_collection: 'tools', meta: { many_collection: 'manufacturing_operations', many_field: 'tool_id', one_collection: 'tools' } },
            { collection: 'manufacturing_operations', field: 'sample_id', related_collection: 'physical_samples', meta: { many_collection: 'manufacturing_operations', many_field: 'sample_id', one_collection: 'physical_samples' } },
            { collection: 'manufacturing_operations', field: 'secret_id', related_collection: 'people', meta: { many_collection: 'manufacturing_operations', many_field: 'secret_id', one_collection: 'people' } },
            // someone else's m2o pointing at operations: not a relation of the form
            { collection: 'machining_force_analysis', field: 'operation_id', related_collection: 'manufacturing_operations', meta: { many_collection: 'machining_force_analysis', many_field: 'operation_id', one_collection: 'manufacturing_operations', one_field: 'force_analyses' } },
          ],
        };
      }
      if (path === '/fields/manufacturing_operations') {
        return {
          data: [
            { field: 'tool_id', meta: { sort: 2, hidden: false, translations: [{ language: 'en-GB', translation: 'Cutting tool' }] } },
            { field: 'sample_id', meta: { sort: 1, hidden: false } },
            { field: 'secret_id', meta: { sort: 3, hidden: true } },
            { field: 'force_analyses', meta: { sort: 9, hidden: false } },
          ],
        };
      }
      return { data: [] };
    });
    const defs = await loadRelationDefs(api, 'manufacturing_operations');
    expect(defs).toEqual([
      { field: 'sample_id', label: 'Sample', collection: 'physical_samples' },
      { field: 'tool_id', label: 'Cutting tool', collection: 'tools' },
    ]);
  });

  it('resolves a files alias through its junction', async () => {
    const { api } = fakeApi((path) => {
      if (path === '/relations/test_sessions') {
        return {
          data: [
            { collection: 'session_data_files', field: 'session_id', related_collection: 'test_sessions', meta: { many_collection: 'session_data_files', many_field: 'session_id', one_collection: 'test_sessions', one_field: 'session_data_files', junction_field: 'directus_files_id' } },
          ],
        };
      }
      // the far leg of the junction is not a relation of test_sessions: it is read from the junction
      if (path === '/relations/session_data_files') {
        return {
          data: [
            { collection: 'session_data_files', field: 'directus_files_id', related_collection: 'directus_files', meta: { many_collection: 'session_data_files', many_field: 'directus_files_id', one_collection: 'directus_files' } },
          ],
        };
      }
      if (path === '/fields/test_sessions') return { data: [{ field: 'session_data_files', meta: { hidden: false, sort: 1 } }] };
      return { data: [] };
    });
    expect(await loadRelationDefs(api, 'test_sessions')).toEqual([
      { field: 'session_data_files', label: 'Session data files', collection: 'directus_files' },
    ]);
  });

  it('fields refused -> null (the caller uses FALLBACK_RELATIONS)', async () => {
    const { api } = fakeApi((path) => (path.startsWith('/fields/') ? httpError(403) : { data: [] }));
    expect(await loadRelationDefs(api, 'manufacturing_operations')).toBeNull();
  });

  it('relations refused -> null', async () => {
    const { api } = fakeApi((path) => (path.startsWith('/relations/') ? httpError(403) : { data: [] }));
    expect(await loadRelationDefs(api, 'test_sessions')).toBeNull();
  });
});

describe('loadUsedIn', () => {
  it('tool -> filter tool_id, limit 20, total from meta.filter_count', async () => {
    const { api, calls } = fakeApi((path) => {
      if (path === '/items/manufacturing_operations') {
        return {
          data: [{ operation_id: 'o1', pass_code: 'MC-1', process_category: 'machining', method_id: { method_id: 'm', method_name: 'Mill' } }],
          meta: { filter_count: 57 },
        };
      }
      return { data: [] };
    });
    const res = await loadUsedIn(api, { collection: 'tools', id: 'tool1' }, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/items/manufacturing_operations');
    expect(filterOf(calls[0])).toEqual({ tool_id: { _eq: 'tool1' } });
    expect(calls[0].params).toMatchObject({ limit: 20, page: 1, meta: 'filter_count' });
    expect(calls[0].params.sort).toEqual(['-operation_date']);
    expect(res.total).toBe(57);
    expect((res.items as { id: string }[]).map((o) => o.id)).toEqual(['o1']);
  });

  it('uses the page for the offset', async () => {
    const { api, calls } = fakeApi(() => ({ data: [], meta: { filter_count: 0 } }));
    await loadUsedIn(api, { collection: 'fast_recipes', id: 'r1' }, 3);
    expect(calls[0].params.page).toBe(3);
    expect(filterOf(calls[0])).toEqual({ fast_recipe_id: { _eq: 'r1' } });
  });

  it('equipment and insert edges also list tests', async () => {
    const { api, calls } = fakeApi((path) => {
      if (path === '/items/test_sessions') return { data: [{ session_id: 't1' }], meta: { filter_count: 4 } };
      return { data: [{ operation_id: 'o1', process_category: 'machining' }], meta: { filter_count: 9 } };
    });
    const res = await loadUsedIn(api, { collection: 'insert_edges', id: 'e1' }, 1);
    expect(calls.map((c) => c.path).sort()).toEqual(['/items/manufacturing_operations', '/items/test_sessions']);
    expect(filterOf(calls.find((c) => c.path === '/items/test_sessions')!)).toEqual({ insert_edge_id: { _eq: 'e1' } });
    expect(res.total).toBe(9);
    expect(res.tests?.map((t) => t.id)).toEqual(['t1']);
    expect(res.testsTotal).toBe(4);
  });

  it('material / project -> samples', async () => {
    const { api, calls } = fakeApi(() => ({ data: [{ sample_id: 's1', sample_code: 'S1' }], meta: { filter_count: 1 } }));
    await loadUsedIn(api, { collection: 'materials', id: 'm1' }, 1);
    const res = await loadUsedIn(api, { collection: 'projects', id: 'p1' }, 1);
    expect(calls.map((c) => c.path)).toEqual(['/items/physical_samples', '/items/physical_samples']);
    expect(filterOf(calls[0])).toEqual({ material_id: { _eq: 'm1' } });
    expect(filterOf(calls[1])).toEqual({ project_id: { _eq: 'p1' } });
    expect((res.items as { id: string; code: string }[])[0]).toMatchObject({ id: 's1', code: 'S1' });
  });

  it('campaign -> samples through the campaign_samples junction', async () => {
    const { api, calls } = fakeApi(() => ({
      data: [{ sample_id: { sample_id: 's1', sample_code: 'S1' } }, { sample_id: null }],
      meta: { filter_count: 2 },
    }));
    const res = await loadUsedIn(api, { collection: 'campaigns', id: 'c1' }, 2);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/items/campaign_samples');
    expect(filterOf(calls[0])).toEqual({ campaign_id: { _eq: 'c1' } });
    expect(calls[0].params).toMatchObject({ limit: 20, page: 2, meta: 'filter_count' });
    expect(calls[0].params.fields).toContain('sample_id.sample_code');
    // a sample the person cannot read is dropped, and the count stays the junction's
    expect((res.items as { id: string; code: string }[]).map((s) => s.id)).toEqual(['s1']);
    expect(res.total).toBe(2);
  });

  it('stock lot -> samples through sample_stock_provenance, then their making operations', async () => {
    const { api, calls } = fakeApi((path) => {
      if (path === '/items/sample_stock_provenance') {
        return { data: [{ sample_id: 's1' }, { sample_id: 's2' }], meta: { filter_count: 31 } };
      }
      return { data: [{ operation_id: 'o9', process_category: 'sintering', output_sample_id: 's1' }] };
    });
    const res = await loadUsedIn(api, { collection: 'raw_stock_lots', id: 'L1' }, 2);
    expect(calls[0].path).toBe('/items/sample_stock_provenance');
    expect(filterOf(calls[0])).toEqual({ lot_id: { _eq: 'L1' } });
    expect(calls[0].params).toMatchObject({ limit: 20, page: 2, meta: 'filter_count' });
    expect(calls[1].path).toBe('/items/manufacturing_operations');
    expect(filterOf(calls[1])).toEqual({ output_sample_id: { _in: ['s1', 's2'] } });
    expect(res.total).toBe(31);
    expect((res.items as { id: string }[]).map((o) => o.id)).toEqual(['o9']);
  });

  it('a lot with no samples on the page makes no operations request', async () => {
    const { api, calls } = fakeApi(() => ({ data: [], meta: { filter_count: 0 } }));
    const res = await loadUsedIn(api, { collection: 'raw_stock_lots', id: 'L1' }, 1);
    expect(calls).toHaveLength(1);
    expect(res).toMatchObject({ items: [], total: 0 });
  });

  it('rejects a collection with no fan', async () => {
    const { api } = fakeApi(() => ({ data: [] }));
    await expect(loadUsedIn(api, { collection: 'people', id: 'x' }, 1)).rejects.toThrow(/used-in/);
  });
});

describe('loadRecordRef', () => {
  it('names a tool, a machine, a stock lot or a project from its own row', async () => {
    const { api, calls } = fakeApi((path) => {
      if (path === '/items/tools/t1') return { data: { tool_id: 't1', tool_code: 'TL-9', tool_name: 'Insert holder' } };
      if (path === '/items/raw_stock_lots/l1') return { data: { lot_id: 'l1', lot_code: 'LOT-3', supplier_name: 'AP&C' } };
      if (path === '/items/fast_recipes/r1') return { data: { id: 'r1', name: 'Ti64 a' } };
      return httpError(404);
    });
    expect(await loadRecordRef(api, { collection: 'tools', id: 't1' })).toEqual({ collection: 'tools', id: 't1', code: 'TL-9', label: 'Insert holder' });
    expect(await loadRecordRef(api, { collection: 'raw_stock_lots', id: 'l1' })).toEqual({ collection: 'raw_stock_lots', id: 'l1', code: 'LOT-3', label: 'AP&C' });
    expect(await loadRecordRef(api, { collection: 'fast_recipes', id: 'r1' })).toEqual({ collection: 'fast_recipes', id: 'r1', code: 'Ti64 a' });
    expect(calls[0].params.fields).toEqual(['tool_id', 'tool_code', 'tool_name']);
  });

  it('a missing or unreadable record rejects as not visible; an unknown collection is refused without a request', async () => {
    const { api, calls } = fakeApi(() => httpError(403));
    await expect(loadRecordRef(api, { collection: 'tools', id: 'x' })).rejects.toSatisfy(isNotVisible);
    await expect(loadRecordRef(api, { collection: 'widgets', id: 'x' })).rejects.toThrow(/cannot name/);
    expect(calls).toHaveLength(1);
    const empty = fakeApi(() => ({ data: null }));
    await expect(loadRecordRef(empty.api, { collection: 'tools', id: 'x' })).rejects.toSatisfy(isNotVisible);
  });

});

describe('loadStepRow and sampleOfRow', () => {
  it('an operation: its input sample, else its output', async () => {
    const { api } = fakeApi(() => ({ data: { operation_id: 'o1', pass_code: 'P1', sample_id: 's1', output_sample_id: 's2', method_id: { method_id: 'm', method_name: 'Cut' } } }));
    const row = await loadStepRow(api, { collection: 'manufacturing_operations', id: 'o1' });
    expect(row).toMatchObject({ id: 'o1', sampleId: 's1', outputSampleId: 's2' });
    expect(sampleOfRow(row)).toBe('s1');
    expect(sampleOfRow({ ...row, sampleId: null } as typeof row)).toBe('s2');
    expect(sampleOfRow({ ...row, sampleId: null, outputSampleId: null } as typeof row)).toBeNull();
  });

  it('a test: its first subject, else its own sample', async () => {
    const { api, calls } = fakeApi(() => ({ data: { session_id: 't1', sample_id: 'sa', test_code: 'T-1', subject: [{ collection: 'physical_samples', item: 'sb' }] } }));
    const test = await loadStepRow(api, { collection: 'test_sessions', id: 't1' });
    expect(sampleOfRow(test)).toBe('sb');
    expect(calls[0].params.fields).toContain('subject.item');

    const bare = fakeApi(() => ({ data: { session_id: 't1', sample_id: 'sa' } }));
    expect(sampleOfRow(await loadStepRow(bare.api, { collection: 'test_sessions', id: 't1' }))).toBe('sa');
  });

  it('a test read refused with the subject junction is read again without it', async () => {
    let n = 0;
    const { api, calls } = fakeApi((_path, params) => {
      n++;
      return (params.fields as string[]).includes('subject.item') ? httpError(403) : { data: { session_id: 't1', sample_id: 'sa' } };
    });
    expect(sampleOfRow(await loadStepRow(api, { collection: 'test_sessions', id: 't1' }))).toBe('sa');
    expect(n).toBe(2);
    expect(calls[1].params.fields).not.toContain('subject.item');
  });

  it('a missing step rejects as not visible, another collection is refused', async () => {
    const { api } = fakeApi(() => ({ data: null }));
    await expect(loadStepRow(api, { collection: 'manufacturing_operations', id: 'x' })).rejects.toSatisfy(isNotVisible);
    await expect(loadStepRow(api, { collection: 'tools', id: 'x' })).rejects.toThrow(/not an operation or a test/);
  });
});

describe('loadFamily: the pieces outside the family (C1)', () => {
  // S was cut into A (the map's sample), B and C: the trace names S and A only.
  const cutsOfS = (path: string, params: Record<string, any>, extra?: () => unknown): unknown => {
    if (path.startsWith('/d1-trace/')) {
      return trace({ sample: { sample_id: 'a', sample_code: 'A', form: null }, ancestors: [{ ...relative('s'), relationship_type: 'cut_from' }] });
    }
    if (path === '/items/manufacturing_operations') {
      const col = Object.keys(JSON.parse(params.filter))[0];
      const rows = ['a', 'b', 'c'].map((p) => ({ operation_id: `cut-${p}`, sample_id: 's', output_sample_id: p, process_category: 'machining' }));
      return { data: col === 'sample_id' ? rows : rows.filter((r) => r.output_sample_id === 'a') };
    }
    if (path === '/items/physical_samples') {
      const wanted: string[] = JSON.parse(params.filter).sample_id._in;
      return extra ? extra() : { data: wanted.map((id) => ({ sample_id: id, sample_code: `CODE-${id}`, form: 'disc' })) };
    }
    return { data: [] };
  };

  it('reads the codes of the outputs that are not in the family, in one extra request of their own', async () => {
    const { api, calls } = fakeApi((path, params) => cutsOfS(path, params));
    const data = await loadFamily(api, 'a');
    expect(data.samples.map((s) => s.id).sort()).toEqual(['a', 's']);
    expect(data.pieces).toEqual({ b: { code: 'CODE-b', form: 'disc' }, c: { code: 'CODE-c', form: 'disc' } });
    const asked = calls.filter((c) => c.path === '/items/physical_samples').map((c) => JSON.parse(c.params.filter).sample_id._in.slice().sort());
    expect(asked).toEqual(expect.arrayContaining([['b', 'c']]));
  });

  it('a refused read of those pieces leaves them without a code, not the map without a family', async () => {
    const { api } = fakeApi((path, params) =>
      path === '/items/physical_samples' && JSON.parse(params.filter).sample_id._in.includes('b')
        ? httpError(403)
        : cutsOfS(path, params),
    );
    const data = await loadFamily(api, 'a');
    expect(data.operations).toHaveLength(3);
    expect(data.pieces ?? {}).toEqual({});
  });
});
