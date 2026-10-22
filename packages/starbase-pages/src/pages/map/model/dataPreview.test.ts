import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { dataPreview } from './dataPreview';
import type { Ref } from './types';

const op = (id: string): Ref => ({ collection: 'manufacturing_operations', id, code: `OP-${id}` });

/** An api whose `/items/<collection>` answers come from `rows`; a collection in `refuse` answers 403. */
function fakeApi(rows: Record<string, unknown[]>, refuse: string[] = []) {
  const get = vi.fn(async (path: string, _config?: unknown) => {
    const collection = path.replace('/items/', '');
    if (refuse.includes(collection)) throw Object.assign(new Error('HTTP 403'), { response: { status: 403 } });
    return { data: { data: rows[collection] ?? [] } };
  });
  return { api: { get } as unknown as HostApi, get };
}

describe('dataPreview', () => {
  it('a finished force analysis gives the Fz figure and the Force dashboard path', async () => {
    const { api } = fakeApi({ machining_force_analysis: [{ operation_id: 'a', frm_fz: 'file-fz' }] });
    const out = await dataPreview(api, [op('a')]);
    expect(out.a).toEqual({ kind: 'force', imageFileId: 'file-fz', plotterPath: '/d1-force-dashboard?operation=a' });
  });

  it('a force analysis without a figure is still force data, with no image', async () => {
    const { api } = fakeApi({ machining_force_analysis: [{ operation_id: 'a', frm_fz: null }] });
    const out = await dataPreview(api, [op('a')]);
    expect(out.a.kind).toBe('force');
    expect(out.a.imageFileId).toBeUndefined();
  });

  it('a finished FAST run is kind fast, no image, with the FAST dashboard path', async () => {
    const { api } = fakeApi({ fast_run_data: [{ operation_id: 'b' }] });
    const out = await dataPreview(api, [op('b')]);
    expect(out.b).toEqual({ kind: 'fast', plotterPath: '/d1-fast-dashboard?operation=b' });
  });

  it('an operation with neither is none', async () => {
    const { api } = fakeApi({});
    const out = await dataPreview(api, [op('c')]);
    expect(out.c).toEqual({ kind: 'none', plotterPath: '' });
  });

  it('a refused request (hidden collection) is none, and the other kind still answers', async () => {
    const { api } = fakeApi({ fast_run_data: [{ operation_id: 'b' }], machining_force_analysis: [{ operation_id: 'a', frm_fz: 'x' }] }, ['machining_force_analysis']);
    const out = await dataPreview(api, [op('a'), op('b')]);
    expect(out.a.kind).toBe('none');
    expect(out.b.kind).toBe('fast');
  });

  it('records that are not operations are none and are never asked about', async () => {
    const { api, get } = fakeApi({});
    const out = await dataPreview(api, [{ collection: 'test_sessions', id: 't1', code: 'T-1' }]);
    expect(out.t1.kind).toBe('none');
    expect(get).not.toHaveBeenCalled();
  });

  it('asks only for the plot rows through the existing requests, in chunks; never a file', async () => {
    const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const { api, get } = fakeApi({});
    await dataPreview(api, ids.map(op));
    expect(get.mock.calls.length).toBeGreaterThan(2); // more than one chunk
    for (const [path] of get.mock.calls) expect(['/items/machining_force_analysis', '/items/fast_run_data', '/items/conform_run_data']).toContain(path);
    const asked = new Set<string>();
    for (const [, config] of get.mock.calls) {
      const filter = JSON.parse((config as { params: { filter: string } }).params.filter);
      for (const id of filter._and[0].operation_id._in) asked.add(id);
    }
    expect(asked.size).toBe(400);
  });

  it('nothing to ask for makes no request', async () => {
    const { api, get } = fakeApi({});
    expect(await dataPreview(api, [])).toEqual({});
    expect(get).not.toHaveBeenCalled();
  });
});
