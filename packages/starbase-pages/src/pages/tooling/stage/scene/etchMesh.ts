// The text etched into the tray: dark writing on the tray's top surface, so it is always visible. The slot numbers, and
// two title lines across the ends (the box code at the far end, the insert type at the near end). One small flat quad
// per text, all in one geometry, with one atlas of white glyphs on black used as the material's alpha map (an opaque
// canvas, so filtering and mips never darken a glyph's edge); the material's colour is the ink, so a theme change
// recolours it without redrawing. The placement and packing are pure (tested in Node); only drawing the atlas
// needs a canvas. Millimetres, world space, y up.

import { BufferGeometry, CanvasTexture, Float32BufferAttribute, NoColorSpace } from 'three';
import { numberAspect, type TrayLayout } from './trayMesh';

export const ETCH_LIFT_MM = 0.02; // above the tray top; polygonOffset keeps the quad from z-fighting with it
const TITLE_SIDE_PAD_MM = 2; // a title line stops this far short of the tray's sides
const MIN_TITLE_H_MM = 1.4; // a long title shrinks no further than this; past it the letters are squeezed instead
const TITLE_PAD_MM = 1;
const FONT = (px: number): string => `700 ${px}px 'Inter', system-ui, sans-serif`;
const TITLE_ADVANCE = 0.62; // a bold capital or digit's advance, in em, on average

// The atlas, in pixels: a glyph is drawn at EM_PX inside a cell CELL_H tall; the quad has the cell's proportions
// (numberAspect for a slot number, which the layout also sizes the tray's margins by).
const EM_PX = 64;
const CELL_H = 72;
const ATLAS_MAX_W = 2048;

export interface EtchLabel {
	slot: number; // index into layout.slots; -1 for a title line
	text: string;
	x: number; // quad centre
	z: number;
	w: number; // quad size
	h: number;
}

export interface Titles { top: string | null; bottom: string | null } // the box code, the insert type

export interface AtlasCell { x: number; y: number; w: number; h: number } // pixels, from the top left

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

const titleAspect = (chars: number): number => TITLE_ADVANCE * Math.max(1, chars) + 0.12;

// A title line across the tray (centred, at depth `z`), sized from its own room: as tall as the room (less a hair each
// side) and `maxH` allow, shrunk to fit the tray's width down to a minimum, past which the letters are drawn smaller
// instead. The quad is never wider than its atlas cell can be, so the cell's proportions (and the letters) stay true.
function titleLabel(layout: TrayLayout, text: string, z: number, room: number, maxH: number): EtchLabel {
	const avail = Math.max(1, layout.width - 2 * TITLE_SIDE_PAD_MM);
	const aspect = titleAspect(text.length);
	const h = Math.max(MIN_TITLE_H_MM, Math.min(room - 2 * TITLE_PAD_MM, maxH, avail / aspect));
	return { slot: -1, text, x: 0, z, w: Math.min(h * aspect, avail, (h * ATLAS_MAX_W) / CELL_H), h };
}

// Where the text goes. A tray's outer columns put the slot number in the tray's side margin, beside the pocket: the
// first column's on the left, the last column's on the right (a one-column tray: on the left), level with the pocket.
// An inner column, in a tray of more than two, has no margin: its number goes in the strip in front of the pocket
// (toward +z, the bottom of the screen). A single case has one slot: the number goes on the case's front wall. All
// numbers share the height the layout gives them (trayMesh.ts widens the margins so the widest fits). The box code is
// etched along the far end, above the first row (toward -z), and the insert type along the near end, below the last
// row; a single case has only the box code, on its back wall (the front one carries the number).
export function etchLabels(layout: TrayLayout, titles: Titles = { top: null, bottom: null }): EtchLabel[] {
	const h = layout.numberH;
	const out = layout.slots.map((slot, i): EtchLabel => {
		const c = layout.centre(slot.column, slot.row);
		const w = (h * numberCellWidth(slot.label)) / CELL_H;
		const base = { slot: i, text: slot.label, w, h };
		if (layout.single) return { ...base, x: c.x, z: c.z + layout.pocketD / 2 + (layout.depth - layout.pocketD) / 4 };
		const side = slot.column === 0 ? -1 : slot.column === layout.columns - 1 ? 1 : 0;
		if (side === 0) return { ...base, x: c.x, z: c.z + layout.pocketD / 2 + (layout.pitch - layout.pocketD) / 2 };
		return { ...base, x: c.x + side * (layout.pocketW / 2 + layout.sideRoom / 2), z: c.z };
	});
	// The far end is foreshortened and further off, so its line is allowed to be taller than the near end's.
	if (titles.top) out.push(titleLabel(layout, titles.top, -layout.depth / 2 + layout.endRoom / 2, layout.endRoom, layout.endHTop));
	if (titles.bottom && !layout.single) {
		// Past the last row's inner numbers (in front of their pockets), when there are any.
		const clear = layout.columns > 2 ? (layout.pitch - layout.pocketD) / 2 + layout.numberH / 2 + TITLE_PAD_MM : 0;
		out.push(titleLabel(layout, titles.bottom, layout.depth / 2 - (layout.endRoom - clear) / 2, layout.endRoom - clear, layout.endH));
	}
	return out;
}

const numberCellWidth = (text: string): number => Math.ceil(CELL_H * numberAspect(text.length));

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
