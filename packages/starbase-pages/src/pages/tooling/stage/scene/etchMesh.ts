// The text etched into the tray: dark writing on the tray's top surface, so it is always visible. The slot numbers, and
// two title lines across the ends (the box code at the far end, the insert type at the near end). One small flat quad
// per text, all in one geometry, with one atlas of white glyphs on black used as the material's alpha map (an opaque
// canvas, so filtering and mips never darken a glyph's edge); the material's colour is the ink, so a theme change
// recolours it without redrawing. The placement and packing are pure (tested in Node); only drawing the atlas
// needs a canvas. Millimetres, world space, y up.

import { BufferGeometry, CanvasTexture, Float32BufferAttribute, NoColorSpace } from 'three';
import { ATLAS_MAX_W, CELL_H, type EtchLabel } from './etchLayout';

export { etchLabels, type EtchLabel, type Titles } from './etchLayout';

export const ETCH_LIFT_MM = 0.02; // above the tray top; polygonOffset keeps the quad from z-fighting with it
const FONT = (px: number): string => `700 ${px}px 'Inter', system-ui, sans-serif`;

// The atlas, in pixels: a glyph is drawn at EM_PX inside a cell CELL_H tall; the quad has the cell's proportions
// (numberAspect for a slot number, which the layout also sizes the tray's margins by).
const EM_PX = 64;

export interface AtlasCell { x: number; y: number; w: number; h: number } // pixels, from the top left

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));


// Shelf-packs one cell per label into a power-of-two atlas; a cell has its quad's proportions.
export function packAtlas(labels: ReadonlyArray<Pick<EtchLabel, 'w' | 'h'>>): { width: number; height: number; cells: AtlasCell[] } {
	const cells: AtlasCell[] = [];
	let x = 0;
	let y = 0;
	let widest = 1;
	for (const l of labels) {
		const w = Math.min(ATLAS_MAX_W, Math.max(1, Math.ceil((CELL_H * l.w) / l.h)));
		if (x + w > ATLAS_MAX_W) { x = 0; y += CELL_H; }
		cells.push({ x, y, w, h: CELL_H });
		x += w;
		widest = Math.max(widest, x);
	}
	return { width: pow2(widest), height: pow2(y + CELL_H), cells };
}

// The quads as a geometry facing up at height `y`: two triangles per label, in label order (so a hit's faceIndex >> 1
// is the label). The atlas row 0 is the top of the canvas, and the top of a glyph points to -z, away from the camera.
export function buildEtchGeometry(labels: ReadonlyArray<EtchLabel>, atlas: ReturnType<typeof packAtlas>, y: number): BufferGeometry {
	const pos: number[] = [];
	const uv: number[] = [];
	labels.forEach((l, i) => {
		const cell = atlas.cells[i];
		const u0 = cell.x / atlas.width, u1 = (cell.x + cell.w) / atlas.width;
		const vTop = 1 - cell.y / atlas.height, vBottom = 1 - (cell.y + cell.h) / atlas.height;
		const x0 = l.x - l.w / 2, x1 = l.x + l.w / 2, zBack = l.z - l.h / 2, zFront = l.z + l.h / 2;
		const a = [x0, y, zBack, u0, vTop], b = [x0, y, zFront, u0, vBottom], c = [x1, y, zFront, u1, vBottom], d = [x1, y, zBack, u1, vTop];
		for (const v of [a, b, c, a, c, d]) { pos.push(v[0], v[1], v[2]); uv.push(v[3], v[4]); }
	});
	const g = new BufferGeometry();
	g.setAttribute('position', new Float32BufferAttribute(pos, 3));
	g.setAttribute('normal', new Float32BufferAttribute(Array.from({ length: labels.length * 6 }, () => [0, 1, 0]).flat(), 3));
	g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
	return g;
}

// Paints the atlas: white glyphs on black. A line wider than its cell has its font made smaller to fit, never squeezed.
function paintAtlas(ctx: CanvasRenderingContext2D, labels: ReadonlyArray<EtchLabel>, atlas: ReturnType<typeof packAtlas>): void {
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, atlas.width, atlas.height);
	ctx.fillStyle = '#fff';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	labels.forEach((l, i) => {
		const c = atlas.cells[i];
		const room = Math.max(1, c.w - 6);
		let px = EM_PX;
		ctx.font = FONT(px);
		const wide = ctx.measureText(l.text).width;
		if (wide > room) { px = (EM_PX * room) / wide; ctx.font = FONT(px); }
		ctx.fillText(l.text, c.x + c.w / 2, c.y + c.h / 2 + px * 0.04);
	});
}

// The atlas as a texture (an alpha map: linear, no colour), or null where there is no canvas (Node) or no 2D context.
export function drawEtchAtlas(labels: ReadonlyArray<EtchLabel>, atlas: ReturnType<typeof packAtlas>): CanvasTexture | null {
	if (typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = atlas.width;
	canvas.height = atlas.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	paintAtlas(ctx, labels, atlas);
	const texture = new CanvasTexture(canvas);
	texture.colorSpace = NoColorSpace; // glyph coverage, not a colour
	texture.anisotropy = 8; // the text is seen at a slant
	return texture;
}

// Paints the atlas again into its texture (the web font has loaded since it was first drawn).
export function repaintEtchAtlas(texture: CanvasTexture, labels: ReadonlyArray<EtchLabel>, atlas: ReturnType<typeof packAtlas>): void {
	const canvas = texture.image as HTMLCanvasElement;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	paintAtlas(ctx, labels, atlas);
	texture.needsUpdate = true;
}

// The font the atlas is drawn in, to ask the browser to load it (see BoxView).
export const ETCH_FONT = FONT(EM_PX);
