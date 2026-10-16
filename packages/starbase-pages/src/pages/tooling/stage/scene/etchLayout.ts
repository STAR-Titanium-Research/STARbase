// Where the text etched into the tray goes: the slot numbers beside the pockets, the box code and the insert type across the
// ends. Pure and three-free (etchMesh.ts draws it in 3D, the 2D plan draws the same places). Millimetres, world space.

import { numberAspect, type TrayLayout } from './trayLayout';

const TITLE_SIDE_PAD_MM = 2; // a title line stops this far short of the tray's sides
const MIN_TITLE_H_MM = 1.4; // a long title shrinks no further than this; past it the letters are squeezed instead
const TITLE_PAD_MM = 1;
const TITLE_ADVANCE = 0.62; // a bold capital or digit's advance, in em, on average
export const CELL_H = 72; // the atlas cell height in pixels: a quad has its cell's proportions
export const ATLAS_MAX_W = 2048;

export interface EtchLabel {
	slot: number; // index into layout.slots; -1 for a title line
	text: string;
	x: number; // quad centre
	z: number;
	w: number; // quad size
	h: number;
}

export interface Titles { top: string | null; bottom: string | null } // the box code, the insert type

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

export const numberCellWidth = (text: string): number => Math.ceil(CELL_H * numberAspect(text.length));
