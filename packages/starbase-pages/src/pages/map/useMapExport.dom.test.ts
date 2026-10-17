// @vitest-environment happy-dom
// The default `frame` dep, against a real DOM: the copy of the Vue Flow pane that is photographed is the live pane's clone with its wire
// svgs given back the `overflow: visible` that Vue Flow's `.vue-flow` rule would give them (the copy is outside `.vue-flow`).
import { describe, expect, it, vi } from 'vitest';
import { ref, watch } from 'vue';
import type { MapNode, RecordNode } from './model/types';
import { useMapExport } from './useMapExport';

vi.mock('@vue-flow/core', async (orig) => {
  const { ref: vref } = await import('vue');
  const nodes = vref([{ id: 's:a', computedPosition: { x: -300, y: -200 }, dimensions: { width: 300, height: 120 } }]);
  return { ...(await orig<typeof import('@vue-flow/core')>()), useVueFlow: () => ({ getNodes: nodes }) };
});

const sample: RecordNode = { id: 's:a', type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: 'a', code: 'S-0001' }, ins: [], outs: [] };

describe('useMapExport default frame', () => {
  it('copies the pane into the frame with the wire svgs showing their overflow, and leaves the live pane alone', async () => {
    document.body.innerHTML = `<div class="d1-process-map"><div class="vue-flow__transformationpane"><svg class="vue-flow__edges"><g><path class="wire" d="M0 0"/></g></svg></div></div>`;
    const live = document.querySelector<SVGElement>('.vue-flow__edges')!;
    const seen: { copyOverflow: string | undefined; count: number }[] = [];
    const toBlob = vi.fn(async (frame: HTMLElement) => {
      const copy = frame.querySelector<SVGElement>('.pm-export-graph .vue-flow__edges');
      seen.push({ copyOverflow: copy?.style.overflow, count: frame.querySelectorAll('.vue-flow__edges').length });
      return new Blob([new Uint8Array([1])]);
    });
    const exp = useMapExport({
      canvas: { whenSettled: async () => true } as never,
      projectFrame: () => null,
      map: { nodes: ref<MapNode[]>([sample]), data: ref({ focus: { kind: 'sample', code: 'S-0001', collection: 'physical_samples', id: 'a' } }), clearHover: vi.fn() } as never,
      person: () => null,
      deps: {
        loadCapture: async () => ({ toPng: vi.fn(), toBlob }),
        save: vi.fn(),
        backgroundColor: () => '#fff',
      },
    });
    // The page draws the ExportFrame once framePlan is set; here the test draws it.
    watch(exp.framePlan, (p) => {
      if (p && !document.querySelector('.pm-export-frame')) document.body.insertAdjacentHTML('beforeend', '<div class="pm-export-frame"><div class="pm-export-graph"></div></div>');
    }, { flush: 'sync' });
    await exp.exportAs('png');
    expect(exp.error.value).toBe('');
    expect(seen).toEqual([{ copyOverflow: 'visible', count: 1 }]);
    expect(live.style.overflow).toBe('');
  });
});
