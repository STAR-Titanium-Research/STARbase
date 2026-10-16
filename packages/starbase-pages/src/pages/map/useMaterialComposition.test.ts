import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { useMaterialComposition } from './useMaterialComposition';

const tick = () => new Promise((r) => setTimeout(r, 0));
const rows = [{ symbol: 'Ti', weight_percent: 89.5 }, { symbol: 'Al', weight_percent: 6 }, { symbol: 'V', weight_percent: 4 }];
const apiOf = (get: (path: string, config?: unknown) => Promise<unknown>) => ({ get: vi.fn(get) }) as unknown as HostApi & { get: ReturnType<typeof vi.fn> };

describe('useMaterialComposition', () => {
  it('reads a material\'s element rows with one request, and asks nothing more for it', async () => {
    const api = apiOf(async () => ({ data: { data: rows } }));
    const c = useMaterialComposition(api);
    c.load('m1');
    c.load('m1'); // hovered again while the first read is on its way
    await tick();
    c.load('m1'); // and after it
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).toBe('/items/material_alloying_elements');
    expect(JSON.stringify(api.get.mock.calls[0][1])).toContain('m1');
    expect(c.compositions.value.m1).toEqual(rows);
  });

  it('is one request per material', async () => {
    const api = apiOf(async () => ({ data: { data: rows } }));
    const c = useMaterialComposition(api);
    c.load('m1');
    c.load('m2');
    await tick();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(Object.keys(c.compositions.value).sort()).toEqual(['m1', 'm2']);
  });

  it('a refused read (403) is null, not an error, and is not asked again', async () => {
    const api = apiOf(async () => Promise.reject(Object.assign(new Error('Forbidden'), { response: { status: 403 } })));
    const c = useMaterialComposition(api);
    c.load('m1');
    await tick();
    expect(c.compositions.value.m1).toBeNull();
    c.load('m1');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('a failed read (500, network) is not an answer: nothing is held, and the next ask reads again', async () => {
    let fail = true;
    const api = apiOf(async () => (fail ? Promise.reject(Object.assign(new Error('Server error'), { response: { status: 500 } })) : { data: { data: rows } }));
    const c = useMaterialComposition(api);
    c.load('m1');
    await tick();
    expect('m1' in c.compositions.value).toBe(false);
    fail = false;
    c.load('m1'); // hovered again
    await tick();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(c.compositions.value.m1).toEqual(rows);
    const net = useMaterialComposition(apiOf(async () => Promise.reject(new Error('Network Error')))); // no response at all
    net.load('m1');
    await tick();
    expect('m1' in net.compositions.value).toBe(false);
  });

  it('no rows is null', async () => {
    const c = useMaterialComposition(apiOf(async () => ({ data: { data: [] } })));
    c.load('m1');
    await tick();
    expect(c.compositions.value.m1).toBeNull();
  });

  it('is not an answer until the read has come back', () => {
    const c = useMaterialComposition(apiOf(() => new Promise(() => {})));
    c.load('m1');
    expect('m1' in c.compositions.value).toBe(false);
  });
});
