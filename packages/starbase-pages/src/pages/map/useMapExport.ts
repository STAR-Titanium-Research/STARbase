// Export of the Process map as a PNG or a PDF (spec D26, §10). The map is drawn as it is under the current
// Show settings; the export copies the drawn nodes and wires into an off-screen ExportFrame (the page
// renders it while `framePlan` is set), sized to the whole map at zoom 1 with a header and a legend, and
// html-to-image takes the picture of that frame. The user's own view is never touched: the frame holds a
// copy of the Vue Flow pane, so nothing is moved and nothing has to be put back.
//
// html-to-image and jspdf are loaded by the click that needs them (dynamic import behind `loadToPng` and
// `loadJsPdf`), so they are in chunks of their own and the tests fake them.

import { nextTick, ref, type Ref } from 'vue';
import { useVueFlow } from '@vue-flow/core';
import { saveFile } from '../../labels/saveFile';
import { inlineSvgPaint } from './exportSvg';
import { captureFilter, exportPlan, mergeBounds, type Bounds, type ExportPlan } from './model/exportPlan';
import type { Kind } from './model/types';
import type { useMapCanvas } from './useMapCanvas';
import type { useProcessMap } from './useProcessMap';

type ProcessMap = ReturnType<typeof useProcessMap>;
type MapCanvas = ReturnType<typeof useMapCanvas>;

/** The subset of html-to-image's options the export sets. */
export interface CaptureOptions {
  width: number;
  height: number;
  pixelRatio: number;
  backgroundColor: string;
  /** false: the page's web fonts are embedded in the picture (STARbase's icons are a same-origin font). */
  skipFonts: boolean;
  filter: (node: Element) => boolean;
  style?: Partial<CSSStyleDeclaration>;
}
export type ToPng = (node: HTMLElement, options: CaptureOptions) => Promise<string>;
/** The subset of jsPDF the export uses. */
export interface PdfDoc {
  addImage(data: string, format: 'PNG', x: number, y: number, w: number, h: number): unknown;
  output(type: 'arraybuffer'): ArrayBuffer;
}
export type PdfCtor = new (options: { orientation: 'landscape'; unit: 'mm'; format: 'a4' | 'a3' }) => PdfDoc;

export interface ExportDeps {
  loadToPng: () => Promise<ToPng>;
  loadJsPdf: () => Promise<PdfCtor>;
  /** Hand the finished file to the browser's download. */
  save: (fileName: string, mime: string, bytes: Uint8Array) => void;
  now: () => Date;
  /** Wait for the page to draw the ExportFrame for the plan, put the map in it and return the element to capture. */
  frame: (plan: ExportPlan) => Promise<HTMLElement>;
  backgroundColor: () => string;
}

export interface MapExportOptions {
  canvas: Pick<MapCanvas, 'frame'>;
  map: Pick<ProcessMap, 'nodes' | 'data' | 'clearHover'>;
  /** The name to put on the header; null leaves "by …" out. */
  person: () => string | null;
  deps?: Partial<ExportDeps>;
}

/** The signed-in person's name for the header: first and last name, else the email, else none. */
export function personName(user: { id?: string; first_name?: string; last_name?: string; email?: string } | null | undefined): string | null {
  if (!user) return null;
  const full = [user.first_name, user.last_name].map((s) => s?.trim()).filter(Boolean).join(' ');
  return full || user.email?.trim() || null;
}

const LARGE_MAP_NOTICE = 'Large map: exported at screen resolution';
const FRAME_SELECTOR = '.pm-export-frame';
const GRAPH_SELECTOR = '.pm-export-graph';
/** The element Vue Flow moves and scales (its parent, .vue-flow__viewport, only clips). */
const VIEWPORT_SELECTOR = '.d1-process-map .vue-flow__transformationpane';

/** The bytes of a `data:...;base64,` URL. */
function dataUrlBytes(url: string): Uint8Array {
  const raw = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function useMapExport({ canvas, map, person, deps: given = {} }: MapExportOptions) {
  const vf = useVueFlow();
  const exporting = ref(false);
  const error = ref('');
  const notice = ref('');
  /** Set while an export runs: the page draws an ExportFrame for it. */
  const framePlan: Ref<ExportPlan | null> = ref(null);

  const deps: ExportDeps = {
    loadToPng: async () => (await import('html-to-image')).toPng as ToPng,
    loadJsPdf: async () => (await import('jspdf')).jsPDF as unknown as PdfCtor,
    save: saveFile,
    now: () => new Date(),
    // The frame is drawn by the page once `framePlan` is set; the live Vue Flow pane is copied into it at zoom 1.
    frame: async () => {
      await nextTick();
      const frame = document.querySelector<HTMLElement>(FRAME_SELECTOR);
      const graph = frame?.querySelector<HTMLElement>(GRAPH_SELECTOR);
      const live = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
      const plan = framePlan.value;
      if (!frame || !graph || !live || !plan) throw new Error('the map is not on screen');
      const copy = live.cloneNode(true) as HTMLElement;
      copy.style.transform = `translate(${plan.graph.x}px, ${plan.graph.y}px) scale(1)`;
      // html-to-image does not style what is inside an svg (the wires): give the copy its paint from the live pane.
      inlineSvgPaint(live, copy);
      graph.appendChild(copy);
      return frame;
    },
    backgroundColor: () => {
      const el = document.querySelector<HTMLElement>('.d1-process-map .pm-canvas');
      return (el && getComputedStyle(el).backgroundColor) || '#ffffff';
    },
    ...given,
  };

  /** The drawn map in flow coordinates: every measured node, and the project frame round them. */
  function drawnBounds(): Bounds | null {
    const boxes: Bounds[] = vf.getNodes.value
      .filter((n) => n.dimensions.width > 0 && n.dimensions.height > 0)
      .map((n) => ({ x: n.computedPosition.x, y: n.computedPosition.y, width: n.dimensions.width, height: n.dimensions.height }));
    if (!boxes.length) return null;
    if (canvas.frame.value) boxes.push(canvas.frame.value);
    return mergeBounds(boxes);
  }

  async function exportAs(format: 'png' | 'pdf'): Promise<void> {
    if (exporting.value) return;
    exporting.value = true;
    error.value = '';
    notice.value = '';
    try {
      // The libraries load first (a slow chunk is a wait the person may use to change the map); then the bounds, the plan,
      // the frame and the copy of the pane are taken with nothing awaited in between but the frame's own draw.
      const [toPng, PdfDocument] = await Promise.all([deps.loadToPng(), format === 'pdf' ? deps.loadJsPdf() : Promise.resolve(null)]);
      const bounds = drawnBounds();
      const data = map.data.value;
      if (!bounds || !data) throw new Error('Nothing to export yet.');
      map.clearHover(); // a hovered card dims the rest: the picture is of the map at rest
      const kinds = map.nodes.value.flatMap((n): Kind[] => (n.type === 'record' || n.type === 'container' ? [n.kind] : n.type === 'junction' ? ['junction'] : []));
      const plan = exportPlan({ bounds, kinds, focus: { kind: data.focus.kind, code: data.focus.code }, person: person(), now: deps.now(), format });
      if (plan.screenResolution) notice.value = LARGE_MAP_NOTICE;

      framePlan.value = plan;
      const frame = await deps.frame(plan);
      const png = await toPng(frame, {
        width: plan.width,
        height: plan.height,
        pixelRatio: plan.pixelRatio,
        backgroundColor: deps.backgroundColor(),
        // Not skipped: every card icon is a Material Symbols glyph (a same-origin web font, `font-src 'self' data:`). Skipped, the
        // picture shows the icon's name as text ("science") clipped to a box; embedded, it shows the glyph. Costs a few hundred ms.
        skipFonts: false,
        filter: captureFilter,
        // The frame is drawn invisibly over the page (it must be laid out to be photographed): the picture shows it.
        style: { opacity: '1', position: 'relative', left: '0', top: '0' },
      });

      if (format === 'png') {
        deps.save(plan.fileName, 'image/png', dataUrlBytes(png));
      } else if (PdfDocument && plan.pdf) {
        const { format: pageFormat, orientation, imageBox } = plan.pdf;
        const doc = new PdfDocument({ orientation, unit: 'mm', format: pageFormat });
        doc.addImage(png, 'PNG', imageBox.x, imageBox.y, imageBox.w, imageBox.h);
        deps.save(plan.fileName, 'application/pdf', new Uint8Array(doc.output('arraybuffer')));
      }
    } catch (e) {
      notice.value = '';
      error.value = `Could not export the map: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      framePlan.value = null;
      exporting.value = false;
    }
  }

  return { exporting, error, notice, framePlan, exportAs };
}
