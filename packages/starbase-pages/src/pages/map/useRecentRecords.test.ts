import { describe, expect, it, vi } from 'vitest';
import type { HostApi } from '@d1/ui';
import { MAX_PICKS, loadRecentPicks } from './useRecentRecords';

// The empty state's quick picks (spec section 8): the records this person used lately, through the same
// GET /d1-usage the Home panel reads, only those the map can open on, newest first, at most 8.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tick = (n: number, minutes = 0) => ({ target: `physical_samples:${id(n)}`, last_at: new Date(Date.UTC(2026, 9, 15, 12, minutes)).toISOString() });

function fakeApi(records: Array<{ target: string; last_at?: string }>, opts: { usage?: unknown; itemsFail?: string[] } = {}) {
  const get = vi.fn(async (path: string, config?: { params?: any }) => {
    if (path === '/d1-usage') {
      if (opts.usage instanceof Error) throw opts.usage;
      return { data: opts.usage ?? { pages: [], records } };
    }
    const collection = path.replace('/items/', '');
    if (opts.itemsFail?.includes(collection)) throw Object.assign(new Error('no'), { response: { status: 403 } });
    // Answer every id asked for, labelled by its collection and id.
    const field = Object.keys(JSON.parse(config!.params.filter))[0];
    const ids: string[] = JSON.parse(config!.params.filter)[field]._in;
    return { data: { data: ids.map((i) => ({ [field]: i, sample_code: `S-${i.slice(-2)}`, equipment_name: `Mill ${i.slice(-2)}`, campaign_code: `C-${i.slice(-2)}`, project_code: 'P', operation_code: 'OP', test_code: 'T' })) } };
  });
  return { api: { get } as unknown as HostApi, get };
}

describe('loadRecentPicks', () => {
  it('keeps only the collections the map can open on, linked to their own map', async () => {
    const { api } = fakeApi([
      tick(1, 1),
      { target: `people:${id(2)}`, last_at: tick(2, 2).last_at },
      { target: `equipment:${id(3)}`, last_at: tick(3, 3).last_at },
    ]);
    const picks = await loadRecentPicks(api);
    expect(picks.map((p) => p.target)).toEqual([`equipment:${id(3)}`, `physical_samples:${id(1)}`]);
    expect(picks.map((p) => p.to)).toEqual([`/map?focus=equipment:${id(3)}`, `/map?focus=physical_samples:${id(1)}`]);
    expect(picks.map((p) => p.label)).toEqual(['Mill 03', 'S-01']);
  });

  it('lists the newest first and no more than eight', async () => {
    const records = Array.from({ length: 12 }, (_, n) => tick(n + 1, n)); // 1 oldest .. 12 newest
    const picks = await loadRecentPicks(fakeApi(records.reverse()).api);
    expect(picks).toHaveLength(MAX_PICKS);
    expect(MAX_PICKS).toBe(8);
    expect(picks.map((p) => p.target)).toEqual(Array.from({ length: 8 }, (_, n) => `physical_samples:${id(12 - n)}`));
  });

  it('leaves out a record that did not come back (deleted or unreadable)', async () => {
    const { api } = fakeApi([tick(1, 1), { target: `campaigns:${id(2)}`, last_at: tick(2, 2).last_at }], { itemsFail: ['campaigns'] });
    expect((await loadRecentPicks(api)).map((p) => p.target)).toEqual([`physical_samples:${id(1)}`]);
  });

  it('is empty, not an error, for no usage, an unreadable usage or a malformed answer', async () => {
    expect(await loadRecentPicks(fakeApi([]).api)).toEqual([]);
    expect(await loadRecentPicks(fakeApi([], { usage: new Error('403') }).api)).toEqual([]);
    expect(await loadRecentPicks(fakeApi([], { usage: { records: 'nope' } }).api)).toEqual([]);
    expect(await loadRecentPicks(fakeApi([], { usage: null }).api)).toEqual([]);
  });

  it('asks for nothing when no record is one the map can open on', async () => {
    const { api, get } = fakeApi([{ target: `people:${id(1)}`, last_at: tick(1).last_at }]);
    expect(await loadRecentPicks(api)).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1); // only /d1-usage
  });
});
