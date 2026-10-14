// Where an edge letter sits on an insert. Letters run clockwise from the reference corner: the top
// face first (A, B, ...), then the underside on a double-sided insert, with the first underside letter
// directly under A. CONTEXT.md > Tooling.

import type { InsertGeometry } from './insertGeometry';

export interface EdgePlacement { face: 'top' | 'bottom'; corner: number }

// 'fC' -> 'C', 'b' -> 'B'. The legacy 'f' prefix means nothing. null when it is not a single letter.
export function normaliseEdgeLetter(identifier: string | null | undefined): string | null {
	if (typeof identifier !== 'string') return null;
	const t = identifier.trim().toUpperCase();
	if (/^[A-Z]$/.test(t)) return t;
	const legacy = /^F([A-Z])$/.exec(t);
	return legacy ? legacy[1] : null;
}

export function placeEdge(geom: InsertGeometry, letter: string | null): EdgePlacement | null {
	const l = normaliseEdgeLetter(letter);
	if (l === null) return null;
	const i = l.charCodeAt(0) - 65;
	const per = geom.edgesPerFace;
	if (i < per) return { face: 'top', corner: geom.cuttingCorners[i] };
	if (geom.doubleSided && i < 2 * per) return { face: 'bottom', corner: geom.cuttingCorners[i - per] };
	return null;
}
