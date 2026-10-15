// ISO 1832 indexable-insert designations: CNMG 12 04 08-MF, CCMT09T304, RCMT1204M0 ...
// Pure parsing, no geometry. insertGeometry.ts turns the result into an outline.

export type ShapeLetter = 'C' | 'D' | 'S' | 'T' | 'V' | 'W' | 'R';

export interface IsoInsert {
	raw: string;
	shape: ShapeLetter;
	clearanceDeg: number; // N 0, A 3, B 5, C 7, D 15, E 20, F 25, G 30, P 11, O other -> 0
	doubleSided: boolean; // clearance N and a type letter that is not one-faced
	hole: 'none' | 'cylindrical' | 'countersunk';
	icMm: number | null;
	thicknessMm: number | null;
	noseRadiusMm: number | null; // 00 -> 0 (sharp); M0 (round) -> null
	chipbreaker: string | null; // the suffix after '-', e.g. 'PM'
}

const MM_PER_INCH = 25.4;

// Included angle at the cutting corners, degrees. R is a full circle.
export const SHAPE_ANGLE_DEG: Record<ShapeLetter, number> = { C: 80, D: 55, S: 90, T: 60, V: 35, W: 80, R: 360 };

const CLEARANCE_DEG: Record<string, number> = { N: 0, A: 3, B: 5, C: 7, D: 15, E: 20, F: 25, G: 30, P: 11, O: 0 };

// Type letter (the 4th): the fixing hole, and how many faces carry a hole/chipbreaker feature.
// An insert with a feature on one face only cannot be flipped, so it is single-sided.
const TYPE: Record<string, { hole: IsoInsert['hole']; faces: 1 | 2 }> = {
	N: { hole: 'none', faces: 2 },
	R: { hole: 'none', faces: 1 },
	F: { hole: 'none', faces: 2 },
	A: { hole: 'cylindrical', faces: 2 },
	M: { hole: 'cylindrical', faces: 1 },
	G: { hole: 'cylindrical', faces: 2 },
	W: { hole: 'countersunk', faces: 1 },
	T: { hole: 'countersunk', faces: 1 },
	Q: { hole: 'countersunk', faces: 2 },
	U: { hole: 'countersunk', faces: 2 },
	B: { hole: 'countersunk', faces: 1 },
	H: { hole: 'countersunk', faces: 1 },
	C: { hole: 'countersunk', faces: 2 },
	J: { hole: 'countersunk', faces: 2 },
};

const THICKNESS_MM: Record<string, number> = {
	'01': 1.59, T1: 1.98, '02': 2.38, T2: 2.78, '03': 3.18, T3: 3.97, '04': 4.76, '05': 5.56, '06': 6.35, '07': 7.94, '09': 9.52,
};

// Common size codes -> IC in mm.
const IC_TABLE: Record<string, number> = {
	C12: 12.7, C09: 9.525, C06: 6.35,
	D11: 9.525, D15: 12.7,
	S09: 9.525, S12: 12.7, S15: 15.875, S19: 19.05,
	T11: 6.35, T16: 9.525, T22: 12.7,
	V11: 6.35, V16: 9.525,
	W06: 9.525, W08: 12.7,
};

// Edge length over IC for the sharp polygon of each shape; the code is the (truncated) edge length
// in mm, so IC = (code + 0.5) / ratio, snapped to 1/16 inch. Only used for codes missing from IC_TABLE.
const EDGE_OVER_IC: Record<Exclude<ShapeLetter, 'R'>, number> = {
	C: 1 / Math.sin((80 * Math.PI) / 180),
	D: 1 / Math.sin((55 * Math.PI) / 180),
	S: 1,
	T: Math.sqrt(3),
	V: 1 / Math.sin((35 * Math.PI) / 180),
	W: (1 / Math.tan((40 * Math.PI) / 180) + 1 / Math.tan((80 * Math.PI) / 180)) / 2, // 80 and 160 degree corners
};

function icFromCode(shape: ShapeLetter, code: string): number | null {
	const n = Number(code);
	if (!Number.isFinite(n) || n <= 0) return null;
	if (shape === 'R') return n;
	const known = IC_TABLE[`${shape}${code}`];
	if (known !== undefined) return known;
	const raw = (n + 0.5) / EDGE_OVER_IC[shape];
	const step = MM_PER_INCH / 16;
	return Math.round(raw / step) * step;
}

// 1204 08 -> parts. Spaces and case do not matter, the '-' chipbreaker suffix is optional.
const DESIGNATION = /^([CDSTVWR])([A-GNPO])([A-Z])([A-Z])(\d{2})([0-9T]\d)(\d{2}|M0)?-?([A-Z0-9]+)?$/;

export function parseIsoDesignation(text: string | null | undefined): IsoInsert | null {
	if (typeof text !== 'string') return null;
	const raw = text;
	const dash = text.indexOf('-');
	const head = (dash < 0 ? text : text.slice(0, dash)).replace(/\s+/g, '').toUpperCase();
	const tail = dash < 0 ? '' : text.slice(dash + 1).replace(/\s+/g, '').toUpperCase();
	if (!head) return null;
	// A type code often carries a grade after the chipbreaker ("SM H13A", "MF1 890 (A41)"): if the whole text does not
	// parse, the designation proper (the part before the '-') still decides the shape.
	const m = DESIGNATION.exec(tail ? `${head}-${tail}` : head) ?? DESIGNATION.exec(head);
	if (!m) return null;
	const [, shapeL, clearL, , typeL, sizeCode, thickCode, noseCode, suffix] = m;
	const type = TYPE[typeL];
	if (!type) return null;
	const shape = shapeL as ShapeLetter;
	const clearanceDeg = CLEARANCE_DEG[clearL] ?? 0;
	return {
		raw,
		shape,
		clearanceDeg,
		doubleSided: clearL === 'N' && type.faces === 2,
		hole: type.hole,
		icMm: icFromCode(shape, sizeCode),
		thicknessMm: THICKNESS_MM[thickCode] ?? null,
		noseRadiusMm: noseCode === undefined || noseCode === 'M0' ? null : Number(noseCode) / 10,
		chipbreaker: suffix ?? null,
	};
}

// Milling inserts are not ISO 1832 turning inserts. Sandvik CoroMill 390 ("R390-11 T3 08M-MM S30T") is a rectangle
// with rounded corners: only the sizes whose catalogue dimensions are known are recognised.
export interface MillingInsert {
	raw: string;
	family: 'R390';
	lengthMm: number;
	widthMm: number;
	thicknessMm: number;
	noseRadiusMm: number; // from the "08" of the code, in tenths of a millimetre
	holeDiameterMm: number;
	cuttingEdges: number; // one per long side, so opposite corners are the two cutting corners
}

const R390_SIZES: Record<string, { lengthMm: number; widthMm: number; thicknessMm: number; holeDiameterMm: number }> = {
	'11': { lengthMm: 11.45, widthMm: 6.8, thicknessMm: 3.59, holeDiameterMm: 2.8 },
};

const MILLING = /^R390-?(\d{2})([0-9T]\d)(\d{2})/;

export function parseMillingDesignation(text: string | null | undefined): MillingInsert | null {
	if (typeof text !== 'string') return null;
	const m = MILLING.exec(text.replace(/\s+/g, '').toUpperCase());
	if (!m) return null;
	const size = R390_SIZES[m[1]];
	if (!size) return null;
	return { raw: text, family: 'R390', ...size, noseRadiusMm: Number(m[3]) / 10, cuttingEdges: 2 };
}
