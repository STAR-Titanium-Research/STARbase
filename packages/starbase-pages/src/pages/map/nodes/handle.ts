// Where a socket (Vue Flow Handle) sits for the page's layout direction. Sockets are Left/Right for
// RIGHT and Top/Bottom for DOWN (elkInput's port sides). Several sockets on one edge spread evenly.

import { Position } from '@vue-flow/core';
import type { Dir } from '../model/elkInput';

export const handlePosition = (dir: Dir, side: 'in' | 'out'): Position =>
	dir === 'RIGHT' ? (side === 'in' ? Position.Left : Position.Right) : side === 'in' ? Position.Top : Position.Bottom;

/** Inline style of socket `i` of `n` on a card's edge: on the edge, spread along it. */
export function edgeStyle(dir: Dir, side: 'in' | 'out', i: number, n: number): Record<string, string> {
	const along = `${((i + 1) / (n + 1)) * 100}%`;
	const edge = side === 'in' ? '0' : '100%';
	return dir === 'RIGHT' ? { left: edge, top: along } : { top: edge, left: along };
}
