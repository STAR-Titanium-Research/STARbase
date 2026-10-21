import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { useDataPreviews } from './useDataPreviews';

const op = (id: string) => ({ collection: 'manufacturing_operations', id, code: `OP-${id}` });
const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeApi() {
  const get = vi.fn(async (path: string) => ({ data: { data: path.endsWith('machining_force_analysis') ? [{ operation_id: 'a', frm_fz: 'fz' }] : [] } }));
  return { api: { get } as unknown as HostApi, get };
}

describe('useDataPreviews', () => {
  it('reads every operation once, up front; looking an answer up asks nothing more', async () => {
    const { api, get } = fakeApi();
    const p = useDataPreviews(api);
    p.load([op('a'), op('b')]);
    await tick();
    expect(get).toHaveBeenCalledTimes(3); // the force, FAST and Conform reads, for both operations together
    expect(p.previews.value.a).toMatchObject({ kind: 'force', imageFileId: 'fz' });
    expect(p.previews.value.b.kind).toBe('none');
    void p.previews.value.a; // hovering reads the stored answer
    await tick();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('nothing to read makes no request', async () => {
    const { api, get } = fakeApi();
    const p = useDataPreviews(api);
    p.load([]);
    await tick();
    expect(get).not.toHaveBeenCalled();
    expect(p.previews.value).toEqual({});
  });

  it('an expand asks only for the operations it brought, and keeps the answers it already has (I5)', async () => {
    const { api, get } = fakeApi();
    const p = useDataPreviews(api);
    p.load([op('a'), op('b')]);
    await tick();
    expect(get).toHaveBeenCalledTimes(3);
    p.load([op('a'), op('b'), op('c')]); // the map grew by c
    await tick();
    expect(get).toHaveBeenCalledTimes(6);
    const ids = (call: number) => JSON.stringify(get.mock.calls[call]);
    expect(ids(3)).toContain('c');
    expect(ids(3)).not.toContain('"a"');
    expect(p.previews.value.a).toMatchObject({ kind: 'force', imageFileId: 'fz' }); // not blanked while c is read
    expect(p.previews.value.c.kind).toBe('none');
    p.load([op('a'), op('b'), op('c')]); // nothing new: nothing asked
    await tick();
    expect(get).toHaveBeenCalledTimes(6);
  });

  it('an old answer that arrives after the next expand still lands next to the new one', async () => {
    const { api } = fakeApi();
    const p = useDataPreviews(api);
    p.load([op('a')]);
    p.load([op('a'), op('b')]);
    await tick();
    await tick();
    expect(Object.keys(p.previews.value).sort()).toEqual(['a', 'b']);
  });

  it('a new family forgets the old answers, and a slow answer from the old one is dropped', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const get = vi.fn(async (path: string) => {
      if (get.mock.calls.length <= 2) await slow; // the first family's two reads wait
      return { data: { data: path.endsWith('machining_force_analysis') ? [{ operation_id: 'a', frm_fz: 'old' }] : [] } };
    });
    const p = useDataPreviews({ get } as unknown as HostApi);
    p.load([op('a')]);
    p.reset(); // another family
    p.load([op('z')]);
    release();
    await tick();
    await tick();
    expect(p.previews.value.a).toBeUndefined();
    expect(p.previews.value.z.kind).toBe('none');
  });
});
