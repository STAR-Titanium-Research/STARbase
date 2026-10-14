import { describe, expect, it, vi } from 'vitest';
import { ref, watch } from 'vue';
import { captureFilter } from './model/exportPlan';
import type { ContainerNode, MapNode, RecordNode } from './model/types';
import { personName, useMapExport, type ExportDeps } from './useMapExport';

// Vue Flow measures in a browser: a store with two measured cards.
interface FakeNode {
  id: string;
  computedPosition: { x: number; y: number };
  dimensions: { width: number; height: number };
}
const store = vi.hoisted(() => ({ nodes: null as unknown }));
vi.mock('@vue-flow/core', async (orig) => {
  const { ref: vref } = await import('vue');
  const nodes = vref<FakeNode[]>([
    { id: 's:a', computedPosition: { x: 100, y: 50 }, dimensions: { width: 300, height: 120 } },
    { id: 'op:b', computedPosition: { x: 600, y: 250 }, dimensions: { width: 310, height: 200 } },
  ]);
  store.nodes = nodes;
  return { ...(await orig<typeof import('@vue-flow/core')>()), useVueFlow: () => ({ getNodes: nodes }) };
});
const flowNodes = () => store.nodes as { value: FakeNode[] };

const sample: RecordNode = { id: 's:a', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'a', code: 'S-0001' }, ins: [], outs: [] };
const op = { id: 'op:b', type: 'container', kind: 'operation' } as ContainerNode;

function setup(over: Partial<ExportDeps> = {}, nodes: MapNode[] = [sample, op]) {
  const el = { tag: 'frame' } as unknown as HTMLElement;
  const toPng = vi.fn(async () => 'data:image/png;base64,AAEC');
  const addImage = vi.fn();
  const output = vi.fn(() => new Uint8Array([9, 9]).buffer);
  const jsPdfCtor = vi.fn(function () {
    return { addImage, output };
  });
  const save = vi.fn();
  const clearHover = vi.fn();
  const deps: ExportDeps = {
    loadToPng: async () => toPng,
    loadJsPdf: async () => jsPdfCtor as unknown as Awaited<ReturnType<ExportDeps['loadJsPdf']>>,
    save,
    now: () => new Date(2026, 9, 14, 9, 5),
    frame: async () => el,
    backgroundColor: () => '#fafafa',
    ...over,
  };
  const exp = useMapExport({
    canvas: { frame: ref({ x: 72, y: 12, width: 880, height: 466 }) } as never,
    map: { nodes: ref(nodes), data: ref({ focus: { kind: 'sample', code: 'S-0001', collection: 'physical_samples', id: 'a' } }), clearHover } as never,
    person: () => 'Ada Lovelace',
    deps,
  });
  return { exp, el, toPng, addImage, output, jsPdfCtor, save, clearHover };
}

describe('personName', () => {
  it('is first and last name, else the email, else null', () => {
    expect(personName({ id: 'u', first_name: 'Ada', last_name: 'Lovelace', email: 'a@b.c' })).toBe('Ada Lovelace');
    expect(personName({ id: 'u', first_name: 'Ada', email: 'a@b.c' })).toBe('Ada');
    expect(personName({ id: 'u', email: ' a@b.c ' })).toBe('a@b.c');
    expect(personName({ id: 'u' })).toBeNull();
    expect(personName(null)).toBeNull();
  });
});

describe('useMapExport', () => {
  it('captures the frame with the sizes of the plan and the options the plan names', async () => {
    const { exp, el, toPng } = setup();
    await exp.exportAs('png');
    expect(toPng).toHaveBeenCalledTimes(1);
    const [node, opts] = (toPng.mock.calls as unknown as [HTMLElement, Record<string, unknown>][])[0];
    expect(node).toBe(el);
    expect(opts).toMatchObject({ skipFonts: false, pixelRatio: 2, backgroundColor: '#fafafa', filter: captureFilter });
    // The project frame (x 72..952) is the widest thing drawn: 880 + 2 x 40 padding.
    expect(opts.width).toBe(960);
  });

  it('saves a PNG under the planned name, as the bytes of the data URL', async () => {
    const { exp, save } = setup();
    await exp.exportAs('png');
    expect(save).toHaveBeenCalledTimes(1);
    const [name, mime, bytes] = save.mock.calls[0] as unknown as [string, string, Uint8Array];
    expect(name).toBe('process-map-S-0001-2026-10-14.png');
    expect(mime).toBe('image/png');
    expect([...bytes]).toEqual([0, 1, 2]);
  });

  it('puts the PNG on one landscape page of a PDF, in the planned box', async () => {
    const { exp, save, addImage, jsPdfCtor } = setup();
    await exp.exportAs('pdf');
    expect(jsPdfCtor).toHaveBeenCalledWith({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const call = addImage.mock.calls[0] as unknown as [string, string, number, number, number, number];
    expect(call[0]).toBe('data:image/png;base64,AAEC');
    expect(call[1]).toBe('PNG');
    expect(call[2]).toBeGreaterThanOrEqual(10);
    expect(call[3]).toBeGreaterThanOrEqual(10);
    const [name, mime, bytes] = save.mock.calls[0] as unknown as [string, string, Uint8Array];
    expect(name).toBe('process-map-S-0001-2026-10-14.pdf');
    expect(mime).toBe('application/pdf');
    expect([...bytes]).toEqual([9, 9]);
  });

  it('clears the hover first (dimmed cards must not be exported) and removes the frame afterwards', async () => {
    const { exp, clearHover } = setup();
    const p = exp.exportAs('png');
    expect(exp.exporting.value).toBe(true);
    await p;
    expect(clearHover).toHaveBeenCalled();
    expect(exp.exporting.value).toBe(false);
    expect(exp.framePlan.value).toBeNull();
  });

  it('is a no-op while an export is running', async () => {
    const { exp, toPng } = setup();
    const first = exp.exportAs('png');
    await exp.exportAs('pdf');
    await first;
    expect(toPng).toHaveBeenCalledTimes(1);
  });

  it('a capture that throws sets the error and lets the person try again', async () => {
    const toPng = vi.fn().mockRejectedValueOnce(new Error('canvas too big')).mockResolvedValue('data:image/png;base64,AA==');
    const { exp, save } = setup({ loadToPng: async () => toPng });
    await exp.exportAs('png');
    expect(exp.error.value).toMatch(/canvas too big/);
    expect(exp.exporting.value).toBe(false);
    expect(exp.framePlan.value).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await exp.exportAs('png');
    expect(exp.error.value).toBe('');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('a library that does not load is an error, not a hang', async () => {
    const { exp } = setup({ loadJsPdf: async () => Promise.reject(new Error('chunk failed')) });
    await exp.exportAs('pdf');
    expect(exp.error.value).toMatch(/chunk failed/);
    expect(exp.exporting.value).toBe(false);
  });

  it('says so when the map is too large for more than screen resolution', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 20000, height: 400 } }];
    try {
      const { exp, toPng } = setup();
      await exp.exportAs('png');
      expect(exp.notice.value).toBe('Large map: exported at screen resolution');
      expect((toPng.mock.calls as unknown as [unknown, { pixelRatio: number }][])[0][1].pixelRatio).toBe(1);
    } finally {
      flowNodes().value = saved;
    }
  });

  it('has nothing to export when no card is drawn', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [];
    try {
      const { exp, toPng } = setup();
      await exp.exportAs('png');
      expect(exp.error.value).toMatch(/Nothing to export/);
      expect(toPng).not.toHaveBeenCalled();
      expect(exp.exporting.value).toBe(false);
    } finally {
      flowNodes().value = saved;
    }
  });

  it('gives the frame the plan, whose legend lists the kinds of the shown cards in KINDS order', async () => {
    const { exp } = setup();
    const plans: { legend: { kind: string }[]; header: string[] }[] = [];
    const stop = watch(exp.framePlan, (p) => p && plans.push(p), { flush: 'sync' });
    await exp.exportAs('png');
    stop();
    expect(plans[0].legend.map((l) => l.kind)).toEqual(['sample', 'operation']);
    expect(plans[0].header).toEqual(['Sample S-0001 — Process map', 'Exported 2026-10-14 09:05 by Ada Lovelace']);
  });
});
