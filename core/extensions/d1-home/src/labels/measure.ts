import type { Measure } from '@d1/ui';

// Text width in mm from the browser's own font engine, so the renderer's shrink-to-fit agrees with what
// the print shows. The font is the document's own stack (renderLabelDocument's body font), not the
// Directus app's, or the widths would be those of another face.
const STACK = 'system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif';
const MM_PER_PX = 25.4 / 96;

let ctx: CanvasRenderingContext2D | null | undefined;

// Undefined where there is no canvas (the renderer then uses its own per-character estimate).
export function canvasMeasure(): Measure | undefined {
	if (ctx === undefined) {
		try {
			ctx = document.createElement('canvas').getContext('2d');
		} catch {
			ctx = null;
		}
	}
	const c = ctx;
	if (!c) return undefined;
	return (text, pt, bold) => {
		c.font = `${bold ? 700 : 400} ${pt}pt ${STACK}`;
		return c.measureText(text).width * MM_PER_PX;
	};
}
