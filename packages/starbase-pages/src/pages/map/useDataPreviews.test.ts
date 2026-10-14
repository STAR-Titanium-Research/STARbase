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
    expect(get).toHaveBeenCalledTimes(2); // the force and the FAST read, for both operations together
    expect(p.previews.value.a).toMatchObject({ kind: 'force', imageFileId: 'fz' });
    expect(p.previews.value.b.kind).toBe('none');
    void p.previews.value.a; // hovering reads the stored answer
    await tick();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('nothing to read makes no request', async () => {
    const { api, get } = fakeApi();
    const p = useDataPreviews(api);
    p.load([]);
    await tick();
    expect(get).not.toHaveBeenCalled();
    expect(p.previews.value).toEqual({});
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
    p.load([op('z')]); // another family
    release();
    await tick();
    await tick();
    expect(p.previews.value.a).toBeUndefined();
    expect(p.previews.value.z.kind).toBe('none');
  });
});
