// Defensive readers for what the Record page keeps in localStorage. Persisted data outlives
// releases (invariant 11), so a value written by another version, or damaged, must degrade to
// "use what is good" and never throw during setup.

import type { PlotMode } from './plotModes';

interface LayoutItem { i: string; type: string; x: number; y: number; w: number; h: number }

// windowSec: a Force panel's own time window (#34), persisted with the layout. Absent = follow the
// workspace default (w.plot.windowSec).
export type RecordPanelInst = LayoutItem & { mode?: PlotMode; channels?: string[]; windowSec?: number };

/** Columns of the Record page's grid on a wide window. */
export const GRID_COLS = 12;

export const DEFAULT_LAYOUT: RecordPanelInst[] = [
	{ i: 'options', type: 'options', x: 0, y: 0, w: 2, h: 28 },
	{ i: 'overview', type: 'overview', x: 2, y: 0, w: 6, h: 3 },
	{ i: 'force', type: 'force', x: 2, y: 3, w: 6, h: 12, mode: 'time', channels: ['Fx', 'Fy', 'Fz'] },
	// #108: the bottom plot defaults to the Tacho signal over time (was an Fx/Fy/Fz spectrum). Only new
	// layouts and "Reset layout" pick this up: LS_KEY is deliberately NOT bumped, which would wipe
	// every user's saved arrangement just to change one default.
	{ i: 'tacho', type: 'force', x: 2, y: 15, w: 6, h: 13, mode: 'time', channels: ['Tacho'] },
	{ i: 'frm', type: 'frm', x: 8, y: 0, w: 4, h: 20 },
	{ i: 'rpm', type: 'rpm', x: 8, y: 20, w: 4, h: 8 },
];

export type DockSide = 'left' | 'right';

/** The edge "Move panel to other side" sends it to: the far one, judged by where its centre is. */
export function oppositeSide(layout: readonly LayoutItem[], id: string, cols: number = GRID_COLS): DockSide {
	const p = layout.find((x) => x.i === id);
	if (!p) return 'right';
	return p.x + p.w / 2 < cols / 2 ? 'right' : 'left';
}

/**
 * Docks one panel against the left or right edge of the grid (#136). The grid only pushes
 * collisions DOWN, so dragging a panel to the other side leaves its old columns empty and sends
 * the panels it landed on below the bottom row. Here the panel's column strip is moved instead.
 * Every panel that lies entirely within the strip (the ones stacked above or below it) travels
 * with it to the edge, and the panels entirely on the far side of it close the gap by its width.
 * Nothing changes row or size, so nothing overlaps and the bottom row is unchanged.
 *
 * If a panel straddles the strip's edge (wider than the strip, or only partly in it) the strip
 * cannot be moved cleanly, so the whole layout is mirrored horizontally instead (x' = cols - x - w),
 * which cannot create an overlap either.
 * Returns a new array of new objects; a panel already docked on that side comes back unchanged.
 */
export function dockPanel<T extends LayoutItem>(layout: readonly T[], id: string, side: DockSide, cols: number = GRID_COLS): T[] {
	const out = layout.map((p) => ({ ...p }));
	const p = out.find((x) => x.i === id);
	if (!p) return out;
	const target = side === 'right' ? cols - p.w : 0;
	if (p.x === target) return out;
	const x0 = p.x;
	const x1 = p.x + p.w;
	const within = (o: T) => o.x >= x0 && o.x + o.w <= x1;
	const intersects = (o: T) => o.x < x1 && o.x + o.w > x0;
	if (out.some((o) => intersects(o) && !within(o))) {
		for (const o of out) o.x = cols - o.x - o.w;
		return out;
	}
	const shift = target - x0;
	for (const o of out) {
		if (within(o)) o.x += shift; // the strip, with whatever is stacked in it
		else if (side === 'right' && o.x >= x1) o.x -= p.w; // panels right of the old slot close the gap
		else if (side === 'left' && o.x + o.w <= x0) o.x += p.w; // panels left of the old slot make room
	}
	return out;
}

/**
 * The saved Record layout with every entry that is not usable dropped: a panel type this version
 * does not know (a newer or older release saved it), or one without a grid position. Unknown types
 * are skipped, not fatal: one used to discard the WHOLE layout and reset the operator's
 * arrangement. An empty saved layout (all panels closed) is kept; `null` means nothing usable, so
 * the caller falls back to its default.
 */
export function parseSavedLayout<T extends LayoutItem>(raw: string | null, knownTypes: Record<string, unknown>): T[] | null {
	let parsed: unknown;
	try { parsed = JSON.parse(raw || 'null'); } catch { return null; }
	if (!Array.isArray(parsed)) return null;
	const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
	const kept = parsed.filter((x): x is T => !!x && typeof x === 'object'
		&& typeof (x as any).i === 'string' && typeof (x as any).type === 'string'
		&& Object.prototype.hasOwnProperty.call(knownTypes, (x as any).type)
		&& num((x as any).x) && num((x as any).y) && num((x as any).w) && num((x as any).h));
	// Entries existed but none survived: nothing to show, so the default layout is better than a blank page.
	return kept.length === 0 && parsed.length > 0 ? null : kept;
}

/** The ids the operator dismissed from the recovery banner; an unreadable value is "none". */
export function parseDismissedIds(raw: string | null): Set<string> {
	try {
		const v = JSON.parse(raw || '[]');
		return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	} catch {
		return new Set();
	}
}
