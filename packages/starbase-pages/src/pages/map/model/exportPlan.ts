// The Process map's export (spec D26, §10) decided as plain numbers and words: how big the picture is, how
// sharp it can be, what the header and legend say, what the file is called, where the picture sits on the
// PDF page. No Vue, no DOM: the composable (useMapExport) draws and saves; this is what it follows.

import { KINDS } from '../nodes/kinds';
import type { Kind } from './types';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExportInput {
  /** The drawn map in flow coordinates: the nodes, and the project frame round them. */
  bounds: Bounds;
  /** The kind of every drawn node (repeats are fine). */
  kinds: Kind[];
  focus: { kind: string; code: string };
  /** The signed-in person's name; null leaves "by …" out. */
  person: string | null;
  now: Date;
  format: 'png' | 'pdf';
}

export interface ExportPlan {
  /** The picture's size in CSS px: the header, the map with its padding, the legend. */
  width: number;
  height: number;
  /** Room kept round the map, in flow px. */
  padding: number;
  pixelRatio: number;
  /** Below the usual 2 (the canvas limits of the browser asked for it). */
  reduced: boolean;
  /** Even ratio 1 is over the canvas limits: exported at ratio 1 all the same, and the person is told. */
  screenResolution: boolean;
  header: [string, string];
  legend: { kind: Kind; label: string }[];
  fileName: string;
  headerHeight: number;
  legendHeight: number;
  /** The map's box inside the picture, and where flow (0,0) lands in it (a translation at zoom 1). */
  graph: { width: number; height: number; x: number; y: number };
  pdf?: { format: 'a4' | 'a3'; orientation: 'landscape'; imageBox: { x: number; y: number; w: number; h: number } };
}

const PADDING = 40;
const MIN_WIDTH = 640;
const HEADER_HEIGHT = 64;
const LEGEND_SIDE = 24;
const LEGEND_ITEM = 130;
const LEGEND_ROW = 24;
const LEGEND_PAD = 20;
const WANT_RATIO = 2;
/** Browser canvas limits: each side, and width x height in pixels. */
const MAX_SIDE = 16384;
const MAX_AREA = 268_435_456;
const PAGES = { a4: { w: 297, h: 210 }, a3: { w: 420, h: 297 } } as const;
const MARGIN_MM = 10;

const pad2 = (n: number) => String(n).padStart(2, '0');
const dateOf = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const timeOf = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

const kindWord = (kind: string): string => {
  const label = (KINDS as Record<string, { label: string } | undefined>)[kind]?.label;
  return label ?? (kind ? kind.charAt(0).toUpperCase() + kind.slice(1).replace(/_/g, ' ') : 'Record');
};

/** The box round all the boxes, or null for none. */
export function mergeBounds(boxes: Bounds[]): Bounds | null {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function exportPlan(input: ExportInput): ExportPlan {
  const { bounds, focus, person, now, format } = input;

  const present = new Set(input.kinds);
  const legend = (Object.keys(KINDS) as Kind[]).filter((k) => present.has(k)).map((kind) => ({ kind, label: KINDS[kind].label }));

  const width = Math.ceil(Math.max(MIN_WIDTH, bounds.width + PADDING * 2));
  const perRow = Math.max(1, Math.floor((width - LEGEND_SIDE * 2) / LEGEND_ITEM));
  const legendHeight = legend.length ? LEGEND_PAD + Math.ceil(legend.length / perRow) * LEGEND_ROW : 0;
  const graphHeight = Math.ceil(bounds.height + PADDING * 2);
  const height = HEADER_HEIGHT + graphHeight + legendHeight;

  // The map is drawn at zoom 1, centred across the picture, PADDING below the header.
  const graph = {
    width,
    height: graphHeight,
    x: (width - bounds.width) / 2 - bounds.x,
    y: PADDING - bounds.y,
  };

  const fit = Math.min(WANT_RATIO, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
  const screenResolution = fit < 1;
  const pixelRatio = screenResolution ? 1 : Math.floor(fit * 1000) / 1000;

  const code = focus.code.replace(/[^A-Za-z0-9._-]/g, '_');
  const fileName = `process-map-${code ? `${code}-` : ''}${dateOf(now)}.${format}`;

  const plan: ExportPlan = {
    width,
    height,
    padding: PADDING,
    pixelRatio,
    reduced: pixelRatio < WANT_RATIO,
    screenResolution,
    header: [`${kindWord(focus.kind)} ${focus.code} — Process map`, `Exported ${dateOf(now)} ${timeOf(now)}${person ? ` by ${person}` : ''}`],
    legend,
    fileName,
    headerHeight: HEADER_HEIGHT,
    legendHeight,
    graph,
  };

  if (format === 'pdf') {
    const pageFormat = width / height > 2 ? 'a3' : 'a4';
    const page = PAGES[pageFormat];
    const box = { w: page.w - MARGIN_MM * 2, h: page.h - MARGIN_MM * 2 };
    const scale = Math.min(box.w / width, box.h / height);
    const w = width * scale;
    const h = height * scale;
    plan.pdf = { format: pageFormat, orientation: 'landscape', imageBox: { x: MARGIN_MM + (box.w - w) / 2, y: MARGIN_MM + (box.h - h) / 2, w, h } };
  }
  return plan;
}

/** Everything the picture leaves out: the hover card, the wire tip, Vue Flow's controls and minimap, the notices. */
const LEFT_OUT = ['.hover-card', '.wire-tip', '.vue-flow__controls', '.vue-flow__minimap', '.vue-flow__panel', '.pm-banner'].join(',');

/** html-to-image's `filter`: false drops a node (and what is under it) from the picture. Text nodes have no `matches`. */
export function captureFilter(node: Element): boolean {
  return typeof node.matches === 'function' ? !node.matches(LEFT_OUT) : true;
}
