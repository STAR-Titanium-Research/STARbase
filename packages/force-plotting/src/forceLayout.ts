// Layout rules of the force analysis page (DESIGN.md section 5b), kept pure so they can be tested: the
// column tracks for a page width, the default panel grid and how a saved panel grid is carried forward,
// and the keys of the operation column's tab list.

export type RPanelType = 'signals' | 'frm' | 'wear' | 'doctor';
export type RPanel = { i: string; type: RPanelType; x: number; y: number; w: number; h: number; channels?: Array<'Fx' | 'Fy' | 'Fz'>; rpm?: boolean };

// Columns 1 and 2 are fixed; the rest is the panel grid (column 3 and 4 of the design: the FRM at the left of
// it and Signals filling the right). The page reacts to its own width, not the viewport's (the host reserves
// side chrome): from 1500px the lists are columns, below that they fold into a 44px tab, and under 900px
// everything stacks and the page scrolls.
export type LayoutMode = 'wide' | 'folded' | 'stacked';
export function layoutMode(width: number): LayoutMode { return width < 900 ? 'stacked' : width < 1500 ? 'folded' : 'wide'; }
export function layoutColumns(mode: LayoutMode): string {
	return mode === 'stacked' ? 'minmax(0, 1fr)' : mode === 'folded' ? '44px 300px minmax(0, 1fr)' : '256px 330px minmax(0, 1fr)';
}

// The FRM in the centre column, Signals on the right.
export const RIGHT_DEFAULT: RPanel[] = [
	{ i: 'frm', type: 'frm', x: 0, y: 0, w: 6, h: 20 },
	{ i: 'signals', type: 'signals', x: 6, y: 0, w: 6, h: 20, channels: ['Fx', 'Fy', 'Fz'], rpm: false },
];

// What the page shipped before: Signals left of the FRM. A saved grid that is still exactly that was never
// arranged by the user, so it moves to the new default; any other saved arrangement is kept as it is.
function isOldDefault(v: RPanel[]): boolean {
	if (v.length !== 2) return false;
	const s = v.find((p) => p.i === 'signals'), f = v.find((p) => p.i === 'frm');
	return !!s && !!f && s.type === 'signals' && f.type === 'frm'
		&& s.x === 0 && s.y === 0 && s.w === 6 && s.h === 20 && f.x === 6 && f.y === 0 && f.w === 6 && f.h === 20;
}

/** The saved panel grid (the raw JSON value) as the page should start with it. Unknown panel types make the whole thing unusable. */
export function startingGrid(saved: unknown, knownTypes: readonly string[]): RPanel[] {
	if (Array.isArray(saved) && saved.length && saved.every((p) => p && knownTypes.includes(p.type))) {
		return isOldDefault(saved as RPanel[]) ? RIGHT_DEFAULT.map((p) => ({ ...p })) : (saved as RPanel[]);
	}
	return RIGHT_DEFAULT.map((p) => ({ ...p }));
}

/** The panel grid of a one-column (stacked) page: the panels one under the other in their saved reading order (top row first, left to right), each `h` rows tall. Positions only; the saved grid is untouched. */
export function stackedLayout(items: RPanel[], h = 16): Array<{ i: string; x: number; y: number; w: number; h: number }> {
	return [...items].sort((a, b) => a.y - b.y || a.x - b.x).map((p, n) => ({ i: p.i, x: 0, y: n * h, w: 1, h }));
}

/** Where Left / Right / Home / End move to in a tab list of `count` tabs from tab `at`; null for any other key. */
export function tabTarget(key: string, at: number, count: number): number | null {
	if (key === 'ArrowRight') return (at + 1) % count;
	if (key === 'ArrowLeft') return (at + count - 1) % count;
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	return null;
}

/** The tab a number key picks (1 = first), or null: a modified key, a key typed into a field, or no such tab. */
export function tabForNumberKey(ev: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }, count: number): number | null {
	if (ev.ctrlKey || ev.metaKey || ev.altKey) return null;
	const el = ev.target as { closest?: (sel: string) => unknown } | null;
	if (el?.closest?.('input, textarea, select, [contenteditable]')) return null;
	const i = Number(ev.key) - 1;
	return Number.isInteger(i) && i >= 0 && i < count && ev.key.length === 1 ? i : null;
}
