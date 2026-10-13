// Dropping and keyboard-moving pins, in terms of what the person sees. The saved list can hold pins
// that are not shown (a view or page they lost, records that did not load), so a position among the
// rows shown has to be turned into a position in the saved list before moveTo can use it.
import { moveTo, pinKey } from './sidebarModel';
import type { PinRef, ResolvedPin } from './sidebarModel';

// Where a drop lands among the rows when the pointer is over row `overIndex`, `ratio` of the way down
// it (0 top, 1 bottom): before the row in its upper half, after it in its lower half.
export function dropIndex(overIndex: number, ratio: number): number {
	return ratio >= 0.5 ? overIndex + 1 : overIndex;
}

// The place in the saved list for a drop before row `dropAt` of the rows shown (`dropAt` equal to
// their count means after the last one shown: before the first row that is not shown, else the end).
export function savedIndexFor(pins: PinRef[], shown: ResolvedPin[], dropAt: number): number {
	const before = shown[dropAt];
	if (!before) return pins.length;
	const at = pins.findIndex((p) => pinKey(p) === pinKey(before.ref));
	return at === -1 ? pins.length : at;
}

export function sameOrder(a: PinRef[], b: PinRef[]): boolean {
	return a.length === b.length && a.every((p, i) => pinKey(p) === pinKey(b[i]));
}

// One row up (-1) or down (+1) among the rows shown, past any pin that is not shown. Null when the
// pin is already at that end (or is not in the list).
export function moveAmongShown(pins: PinRef[], shown: ResolvedPin[], item: PinRef, delta: -1 | 1): PinRef[] | null {
	const at = shown.findIndex((r) => pinKey(r.ref) === pinKey(item));
	const neighbour = shown[at + delta];
	if (at === -1 || !neighbour) return null;
	const neighbourAt = pins.findIndex((p) => pinKey(p) === pinKey(neighbour.ref));
	return moveTo(pins, item, delta === -1 ? neighbourAt : neighbourAt + 1);
}

// The list after dropping `item` before row `dropAt` of the rows shown; `pinFirst` says the item is
// not pinned yet (it is added last, then moved), so the caller pins it before sending the order.
export function dropResult(pins: PinRef[], shown: ResolvedPin[], item: PinRef, dropAt: number): { next: PinRef[]; pinFirst: boolean } {
	const pinFirst = !pins.some((p) => pinKey(p) === pinKey(item));
	const index = savedIndexFor(pins, shown, dropAt);
	const base = pinFirst ? [...pins, item] : pins;
	return { next: moveTo(base, item, index), pinFirst };
}
