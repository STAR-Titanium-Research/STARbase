// Export of the Process map as a PNG or a PDF (spec D26, §10). The map is drawn as it is under the current
// Show settings; the export copies the drawn nodes and wires into an off-screen ExportFrame (the page
// renders it while `framePlan` is set), sized to the whole map at zoom 1 with a header and a legend, and
// html-to-image takes the picture of that frame. The user's own view is never touched: the frame holds a
// copy of the Vue Flow pane, so nothing is moved and nothing has to be put back.
//
// html-to-image and jspdf are loaded by the click that needs them (dynamic import behind `loadCapture` and
// `loadJsPdf`), so they are in chunks of their own and the tests fake them.
//
// A browser that refuses a canvas (too many pixels) does not throw: it hands back an empty picture ("data:," or a null/empty
// blob). That is caught here, retried once at ratio 1, and then reported; an empty file is never saved.

import { nextTick, ref, type Ref } from 'vue';
import { useVueFlow } from '@vue-flow/core';
import { saveFile } from '../../labels/saveFile';
import { inlineSvgPaint, showSvgOverflow } from './exportSvg';
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
export type ToBlob = (node: HTMLElement, options: CaptureOptions) => Promise<Blob | null>;
/** The subset of jsPDF the export uses. */
export interface PdfDoc {
  addImage(data: string, format: 'PNG', x: number, y: number, w: number, h: number, alias: string | undefined, compression: 'FAST'): unknown;
  output(type: 'arraybuffer'): ArrayBuffer;
}
export type PdfCtor = new (options: { orientation: 'landscape'; unit: 'mm'; format: 'a4' | 'a3' }) => PdfDoc;

export interface ExportDeps {
  /** A PNG is taken as a blob (no base64 round trip); a PDF takes the data URL jsPDF reads. */
  loadCapture: () => Promise<{ toPng: ToPng; toBlob: ToBlob }>;
  loadJsPdf: () => Promise<PdfCtor>;
  /** Hand the finished file to the browser's download. */
  save: (fileName: string, mime: string, bytes: Uint8Array) => void;
  now: () => Date;
  /** A touch device: its canvas budget is smaller (the plan's area cap is lower). */
  coarse: () => boolean;
  /** Wait for the page to draw the ExportFrame for the plan, put the map in it and return the element to capture. */
  frame: (plan: ExportPlan) => Promise<HTMLElement>;
  backgroundColor: () => string;
}

export interface MapExportOptions {
  canvas: Pick<MapCanvas, 'whenSettled'>;
  /** The project frame in flow coordinates, or null when the page does not draw it (it is part of the map only when it is). */
  projectFrame: () => Bounds | null;
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

const LARGE_MAP_NOTICE = 'Large map: exported at reduced resolution to fit this browser';
const TOO_LARGE = 'This map is too large to export in this browser';
const NOT_SETTLED = 'The map is still rearranging. Try the export again in a moment.';
const FRAME_SELECTOR = '.pm-export-frame';
const GRAPH_SELECTOR = '.pm-export-graph';
/** The element Vue Flow moves and scales (its parent, .vue-flow__viewport, only clips). */
const VIEWPORT_SELECTOR = '.d1-process-map .vue-flow__transformationpane';

/** Does a data URL carry a picture? A refused canvas gives "data:,". */
const hasPayload = (url: string): boolean => url.indexOf(',') >= 0 && url.length > url.indexOf(',') + 1;

/** The bytes of a `data:...;base64,` URL. */
function dataUrlBytes(url: string): Uint8Array {
  const raw = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function useMapExport({ canvas, projectFrame, map, person, deps: given = {} }: MapExportOptions) {
  const vf = useVueFlow();
  const exporting = ref(false);
  const error = ref('');
  const notice = ref('');
  /** Set while an export runs: the page draws an ExportFrame for it. */
  const framePlan: Ref<ExportPlan | null> = ref(null);

  const deps: ExportDeps = {
    loadCapture: async () => {
      const lib = await import('html-to-image');
      return { toPng: lib.toPng as ToPng, toBlob: lib.toBlob as ToBlob };
    },
    loadJsPdf: async () => (await import('jspdf')).jsPDF as unknown as PdfCtor,
    save: saveFile,
    now: () => new Date(),
    coarse: () => {
      try {
        return window.matchMedia('(pointer: coarse)').matches;
      } catch {
        return false;
      }
    },
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
      // The copy is outside `.vue-flow`, so the rule that lets a wire run past its svg's box does not reach it (see showSvgOverflow).
      showSvgOverflow(copy);
      graph.appendChild(copy);
      return frame;
    },
    backgroundColor: () => {
      const el = document.querySelector<HTMLElement>('.d1-process-map .pm-canvas');
      return (el && getComputedStyle(el).backgroundColor) || '#ffffff';
    },
    ...given,
  };

  /** The drawn map in flow coordinates: every measured node, and the project frame round them when the page draws it. */
  function drawnBounds(): Bounds | null {
    const boxes: Bounds[] = vf.getNodes.value
      .filter((n) => n.dimensions.width > 0 && n.dimensions.height > 0)
      .map((n) => ({ x: n.computedPosition.x, y: n.computedPosition.y, width: n.dimensions.width, height: n.dimensions.height }));
    if (!boxes.length) return null;
    const project = projectFrame();
    if (project) boxes.push(project);
    return mergeBounds(boxes);
  }

  async function exportAs(format: 'png' | 'pdf'): Promise<void> {
    if (exporting.value) return;
    exporting.value = true;
    error.value = '';
    notice.value = '';
    try {
      // The libraries load first (a slow chunk is a wait the person may use to change the map), then the map is let to settle (a layout
      // or the move of the cards to their places must not be photographed half way); then the bounds, the plan, the frame and the
      // copy of the pane are taken with nothing awaited in between but the frame's own draw.
      const [capture, PdfDocument] = await Promise.all([deps.loadCapture(), format === 'pdf' ? deps.loadJsPdf() : Promise.resolve(null)]);
      if (!(await canvas.whenSettled())) throw new Error(NOT_SETTLED);
      const bounds = drawnBounds();
      const data = map.data.value;
      if (!bounds || !data) throw new Error('Nothing to export yet.');
      map.clearHover(); // a hovered card dims the rest: the picture is of the map at rest
      const kinds = map.nodes.value.flatMap((n): Kind[] => (n.type === 'record' || n.type === 'container' ? [n.kind] : n.type === 'junction' ? ['junction'] : []));
      const plan = exportPlan({ bounds, kinds, focus: { kind: data.focus.kind, code: data.focus.code }, person: person(), now: deps.now(), format, coarse: deps.coarse() });

      framePlan.value = plan;
      const frame = await deps.frame(plan);
      const options = (pixelRatio: number): CaptureOptions => ({
        width: plan.width,
        height: plan.height,
        pixelRatio,
        backgroundColor: deps.backgroundColor(),
        // Not skipped: every card icon is a Material Symbols glyph (a same-origin web font, `font-src 'self' data:`). Skipped, the
        // picture shows the icon's name as text ("science") clipped to a box; embedded, it shows the glyph. Costs a few hundred ms.
        skipFonts: false,
        filter: captureFilter,
        // The frame is drawn invisibly over the page (it must be laid out to be photographed): the picture shows it.
        style: { opacity: '1', position: 'relative', left: '0', top: '0' },
      });
      /** One picture at `ratio`: the PNG's blob or the PDF's data URL; null when the browser gave back an empty one. */
      const take = async (ratio: number): Promise<{ blob?: Blob; url?: string } | null> => {
        if (format === 'png') {
          const blob = await capture.toBlob(frame, options(ratio));
          return blob && blob.size > 0 ? { blob } : null;
        }
        const url = await capture.toPng(frame, options(ratio));
        return hasPayload(url) ? { url } : null;
      };

      // A PDF needs no more than 300 dpi on its page, so it has a ratio of its own (never above the PNG's).
      let ratio = format === 'pdf' && plan.pdf ? plan.pdf.pixelRatio : plan.pixelRatio;
      let picture = await take(ratio);
      let retried = false;
      if (!picture && ratio > 1) {
        retried = true;
        ratio = 1;
        picture = await take(ratio);
      }
      if (!picture) throw new Error(TOO_LARGE);
      if (plan.reduced || retried) notice.value = `${LARGE_MAP_NOTICE} (pixel ratio ${Number(ratio.toFixed(2))})`;

      if (picture.blob) {
        deps.save(plan.fileName, 'image/png', new Uint8Array(await picture.blob.arrayBuffer()));
      } else if (picture.url && PdfDocument && plan.pdf) {
        const { format: pageFormat, orientation, imageBox } = plan.pdf;
        const doc = new PdfDocument({ orientation, unit: 'mm', format: pageFormat });
        doc.addImage(picture.url, 'PNG', imageBox.x, imageBox.y, imageBox.w, imageBox.h, undefined, 'FAST');
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

  const dismissError = () => {
    error.value = '';
  };

  return { exporting, error, notice, framePlan, exportAs, dismissError };
}
