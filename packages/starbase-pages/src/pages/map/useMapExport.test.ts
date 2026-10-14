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

const png = () => new Blob([new Uint8Array([0, 1, 2])], { type: 'image/png' });
const projectBox = { x: 72, y: 12, width: 880, height: 466 };

function setup(over: Partial<ExportDeps> = {}, nodes: MapNode[] = [sample, op], extra: { whenSettled?: () => Promise<boolean>; projectFrame?: () => unknown } = {}) {
  const el = { tag: 'frame' } as unknown as HTMLElement;
  const toPng = vi.fn(async () => 'data:image/png;base64,AAEC');
  const toBlob = vi.fn(async () => png() as Blob | null);
  const addImage = vi.fn();
  const output = vi.fn(() => new Uint8Array([9, 9]).buffer);
  const jsPdfCtor = vi.fn(function () {
    return { addImage, output };
  });
  const save = vi.fn();
  const clearHover = vi.fn();
  const nodesRef = ref<MapNode[]>(nodes);
  const deps: ExportDeps = {
    loadCapture: async () => ({ toPng, toBlob }),
    coarse: () => false,
    loadJsPdf: async () => jsPdfCtor as unknown as Awaited<ReturnType<ExportDeps['loadJsPdf']>>,
    save,
    now: () => new Date(2026, 9, 14, 9, 5),
    frame: async () => el,
    backgroundColor: () => '#fafafa',
    ...over,
  };
  const exp = useMapExport({
    canvas: { whenSettled: extra.whenSettled ?? (async () => true) } as never,
    projectFrame: (extra.projectFrame ?? (() => projectBox)) as never,
    map: { nodes: nodesRef, data: ref({ focus: { kind: 'sample', code: 'S-0001', collection: 'physical_samples', id: 'a' } }), clearHover } as never,
    person: () => 'Ada Lovelace',
    deps,
  });
  return { exp, el, toPng, toBlob, addImage, output, jsPdfCtor, save, clearHover, nodesRef };
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
    const { exp, el, toBlob, toPng } = setup();
    await exp.exportAs('png');
    expect(toBlob).toHaveBeenCalledTimes(1); // a PNG is taken as a blob: no base64 round trip
    expect(toPng).not.toHaveBeenCalled();
    const [node, opts] = (toBlob.mock.calls as unknown as [HTMLElement, Record<string, unknown>][])[0];
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

  it('puts the PNG on one landscape page of a PDF, in the planned box, compressed FAST', async () => {
    const { exp, save, addImage, jsPdfCtor, toBlob } = setup();
    await exp.exportAs('pdf');
    expect(toBlob).not.toHaveBeenCalled();
    expect(jsPdfCtor).toHaveBeenCalledWith({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const call = addImage.mock.calls[0] as unknown as [string, string, number, number, number, number, unknown, string];
    expect(call[0]).toBe('data:image/png;base64,AAEC');
    expect(call[1]).toBe('PNG');
    expect(call[6]).toBeUndefined();
    expect(call[7]).toBe('FAST');
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
    const { exp, toBlob, toPng } = setup();
    const first = exp.exportAs('png');
    await exp.exportAs('pdf');
    await first;
    expect(toBlob).toHaveBeenCalledTimes(1);
    expect(toPng).not.toHaveBeenCalled();
  });

  it('a capture that throws sets the error and lets the person try again', async () => {
    const toBlob = vi.fn().mockRejectedValueOnce(new Error('canvas too big')).mockResolvedValue(png());
    const { exp, save } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob }) });
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

  it('says so, with the ratio it used, when the map is too large for the usual sharpness', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 20000, height: 400 } }];
    try {
      const { exp, toBlob } = setup();
      await exp.exportAs('png');
      expect(exp.notice.value).toBe('Large map: exported at reduced resolution to fit this browser (pixel ratio 1)');
      expect((toBlob.mock.calls as unknown as [unknown, { pixelRatio: number }][])[0][1].pixelRatio).toBe(1);
    } finally {
      flowNodes().value = saved;
    }
  });

  it('has nothing to export when no card is drawn', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [];
    try {
      const { exp, toBlob } = setup();
      await exp.exportAs('png');
      expect(exp.error.value).toMatch(/Nothing to export/);
      expect(toBlob).not.toHaveBeenCalled();
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

  it('takes the bounds and the legend after the libraries have loaded, so changes made during a slow load are in the picture', async () => {
    const saved = flowNodes().value;
    let release!: () => void;
    const toBlob = vi.fn(async () => png() as Blob | null);
    const { exp, nodesRef } = setup({ loadCapture: () => new Promise((res) => (release = () => res({ toPng: vi.fn(), toBlob }))) }, [sample]);
    const plans: { width: number; legend: { kind: string }[] }[] = [];
    const stop = watch(exp.framePlan, (p) => p && plans.push(p), { flush: 'sync' });
    try {
      const run = exp.exportAs('png');
      flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 2000, height: 100 } }]; // the map grew while the chunk loaded
      nodesRef.value = [sample, op]; // and a Show chip was turned on
      release();
      await run;
      expect(toBlob).toHaveBeenCalledTimes(1);
      expect(plans[0].width).toBe(2080);
      expect(plans[0].legend.map((l) => l.kind)).toEqual(['sample', 'operation']);
    } finally {
      stop();
      flowNodes().value = saved;
    }
  });

  it('does not leave the large-map notice behind when the capture then fails', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 20000, height: 400 } }];
    try {
      const { exp } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob: vi.fn().mockRejectedValue(new Error('boom')) }) });
      await exp.exportAs('png');
      expect(exp.error.value).toMatch(/boom/);
      expect(exp.notice.value).toBe('');
    } finally {
      flowNodes().value = saved;
    }
  });
  it('takes the PDF at its own pixel ratio: enough for 300 dpi on the page, not the PNG ratio of 2', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 4000, height: 400 } }];
    try {
      const { exp, toPng } = setup({}, [sample, op], { projectFrame: () => null });
      await exp.exportAs('pdf');
      const ratio = (toPng.mock.calls as unknown as [unknown, { pixelRatio: number }][])[0][1].pixelRatio;
      expect(ratio).toBeLessThan(2);
      expect(ratio).toBeGreaterThanOrEqual(1);
      expect(exp.notice.value).toBe(''); // a PDF that needs less than 2 is not a "large map"
    } finally {
      flowNodes().value = saved;
    }
  });

  it('leaves the project frame out of the bounds when the page does not draw it', async () => {
    const { exp, toBlob } = setup({}, [sample, op], { projectFrame: () => null });
    await exp.exportAs('png');
    // the nodes alone span x 100..910: 810 + 2 x 40
    expect((toBlob.mock.calls as unknown as [unknown, { width: number }][])[0][1].width).toBe(890);
  });

  it('a picture with no payload (the browser refused the canvas) is retried once at ratio 1, and then reported, never saved', async () => {
    const toBlob = vi.fn().mockResolvedValue(null);
    const { exp, save } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob }) });
    await exp.exportAs('png');
    expect(toBlob).toHaveBeenCalledTimes(2);
    expect((toBlob.mock.calls as unknown as [unknown, { pixelRatio: number }][])[1][1].pixelRatio).toBe(1);
    expect(exp.error.value).toBe('Could not export the map: This map is too large to export in this browser');
    expect(save).not.toHaveBeenCalled();
    expect(exp.exporting.value).toBe(false);
  });

  it('an empty blob counts as no payload; the retry that works is saved and the notice says the ratio used', async () => {
    const toBlob = vi.fn().mockResolvedValueOnce(new Blob([])).mockResolvedValue(png());
    const { exp, save } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob }) });
    await exp.exportAs('png');
    expect(save).toHaveBeenCalledTimes(1);
    expect(exp.error.value).toBe('');
    expect(exp.notice.value).toBe('Large map: exported at reduced resolution to fit this browser (pixel ratio 1)');
  });

  it('"data:," from toPng is no payload either (PDF path): retry at ratio 1, then the error', async () => {
    const toPng = vi.fn().mockResolvedValue('data:,');
    const { exp, save, jsPdfCtor } = setup({ loadCapture: async () => ({ toPng, toBlob: vi.fn() }) });
    await exp.exportAs('pdf');
    expect(toPng).toHaveBeenCalledTimes(2);
    expect((toPng.mock.calls as unknown as [unknown, { pixelRatio: number }][])[1][1].pixelRatio).toBe(1);
    expect(exp.error.value).toMatch(/too large to export in this browser/);
    expect(jsPdfCtor).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not retry when the picture was already taken at ratio 1', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 20000, height: 400 } }];
    try {
      const toBlob = vi.fn().mockResolvedValue(null);
      const { exp } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob }) });
      await exp.exportAs('png');
      expect(toBlob).toHaveBeenCalledTimes(1);
      expect(exp.error.value).toMatch(/too large to export in this browser/);
    } finally {
      flowNodes().value = saved;
    }
  });

  it('a touch device (pointer: coarse) has the smaller area cap', async () => {
    const saved = flowNodes().value;
    flowNodes().value = [{ id: 'x', computedPosition: { x: 0, y: 0 }, dimensions: { width: 3000, height: 2000 } }];
    try {
      const { exp, toBlob } = setup({ coarse: () => true }, [sample, op], { projectFrame: () => null });
      await exp.exportAs('png');
      const o = (toBlob.mock.calls as unknown as [unknown, { width: number; height: number; pixelRatio: number }][])[0][1];
      expect(o.width * o.pixelRatio * o.height * o.pixelRatio).toBeLessThanOrEqual(16_777_216);
      expect(o.pixelRatio).toBeLessThan(2);
    } finally {
      flowNodes().value = saved;
    }
  });

  it('waits for the layout to settle before it measures, and tells the person if it does not settle', async () => {
    const whenSettled = vi.fn(async () => false);
    const { exp, toBlob, clearHover } = setup({}, [sample, op], { whenSettled });
    await exp.exportAs('png');
    expect(whenSettled).toHaveBeenCalledTimes(1);
    expect(toBlob).not.toHaveBeenCalled();
    expect(clearHover).not.toHaveBeenCalled();
    expect(exp.error.value).toMatch(/still rearranging/);
    expect(exp.exporting.value).toBe(false);
  });

  it('measures only after the settle', async () => {
    const order: string[] = [];
    const toBlob = vi.fn(async () => {
      order.push('capture');
      return png();
    });
    const { exp } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob }) }, [sample, op], {
      whenSettled: async () => {
        order.push('settled');
        return true;
      },
      projectFrame: () => {
        order.push('bounds');
        return projectBox;
      },
    });
    await exp.exportAs('png');
    expect(order).toEqual(['settled', 'bounds', 'capture']);
  });

  it('the error can be dismissed', async () => {
    const { exp } = setup({ loadCapture: async () => ({ toPng: vi.fn(), toBlob: vi.fn().mockRejectedValue(new Error('boom')) }) });
    await exp.exportAs('png');
    expect(exp.error.value).toMatch(/boom/);
    exp.dismissError();
    expect(exp.error.value).toBe('');
  });
});
