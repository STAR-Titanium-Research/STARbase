// Where the hover card goes (spec §6.6): beside the hovered element, flipped to its left when the right
// edge of the canvas is in the way, and below it when neither side has room; always inside the canvas.
// Pure: boxes in, a position relative to the canvas out.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  left: number;
  top: number;
  placement: 'right' | 'left' | 'below';
}

const GAP = 16;
const BELOW_GAP = 10;
const MARGIN = 8;

/** `target` and `canvas` in the same (page) coordinates; the result is relative to the canvas's top-left. */
export function placeCard(target: Box, canvas: Box, card: { width: number; height: number }): Placement {
  const width = canvas.right - canvas.left;
  const height = canvas.bottom - canvas.top;
  const clampTop = (top: number) => Math.max(MARGIN, Math.min(top, height - card.height - MARGIN));

  let left = target.right - canvas.left + GAP;
  if (left + card.width <= width - MARGIN) return { left, top: clampTop(target.top - canvas.top - MARGIN), placement: 'right' };

  left = target.left - canvas.left - card.width - GAP;
  if (left >= MARGIN) return { left, top: clampTop(target.top - canvas.top - MARGIN), placement: 'left' };

  left = Math.max(MARGIN, Math.min(target.left - canvas.left, width - card.width - MARGIN));
  return { left, top: clampTop(target.bottom - canvas.top + BELOW_GAP), placement: 'below' };
}
