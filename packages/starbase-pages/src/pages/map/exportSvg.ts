// html-to-image copies every element's computed style into the picture EXCEPT what is inside an <svg>: it deep-clones an svg
// as it is and does not visit its children, and the picture is rendered without the page's stylesheets. So a wire (a scoped
// `.wire { fill: none; stroke: ... }`) came out as a black filled shape. Before the capture the paint of every shape inside
// an svg of the copied pane is written onto it as an inline style, read from the live element it was cloned from.

/** The properties that decide how an svg shape looks (the rest is geometry, which is in attributes). */
export const SVG_PAINT = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'visibility',
] as const;

interface Styled {
  style: { setProperty(name: string, value: string): void };
}
interface Holder<T> {
  querySelectorAll(selector: string): ArrayLike<T>;
}
export type StyleReader = (el: never) => { getPropertyValue(name: string): string };

/** `copy` is a deep clone of `live`: its svg shapes are in the same order, so they pair up. */
export function inlineSvgPaint<T extends Styled>(live: Holder<T>, copy: Holder<T>, read: StyleReader = (el) => getComputedStyle(el as unknown as Element)): void {
  const from = live.querySelectorAll('svg *');
  const to = copy.querySelectorAll('svg *');
  const n = Math.min(from.length, to.length);
  for (let i = 0; i < n; i++) {
    const computed = read(from[i] as never);
    for (const name of SVG_PAINT) {
      const value = computed.getPropertyValue(name);
      if (value) to[i].style.setProperty(name, value);
    }
  }
}

/**
 * Vue Flow draws each wire in an svg that is only as big as the pane's origin box, and lets the wire run past it with
 * `.vue-flow .vue-flow__edges { overflow: visible }`. The export copy lives outside `.vue-flow` (the ExportFrame is a sibling of the canvas),
 * so that rule no longer reaches it, the browser's default `svg { overflow: hidden }` applies, and html-to-image copies that into the picture:
 * every wire outside the box from the map's origin (0,0) to the frame's size was cut, which on a large map is most of them. The copy's
 * wire svgs get the lost rule back, inline.
 */
export function showSvgOverflow(copy: { querySelectorAll(selector: string): ArrayLike<{ style: { overflow: string } }> }): void {
  const svgs = copy.querySelectorAll('svg.vue-flow__edges');
  for (let i = 0; i < svgs.length; i++) svgs[i].style.overflow = 'visible';
}
