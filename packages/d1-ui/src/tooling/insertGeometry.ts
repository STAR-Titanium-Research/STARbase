// What an insert looks like: the numbers (resolveInsertGeometry) and the 2D outline (insertOutline).
// Millimetres and degrees. The top view has x to the right and y up; corners go clockwise from corner 0.
//
// Every non-round shape is a tangential polygon: all sides touch the inscribed circle (diameter IC),
// so a shape is just its list of interior angles. The nose fillets then sit at (r - RE) / cos(ext / 2)
// from the centre along each corner's bisector.

import { parseIsoDesignation, parseMillingDesignation, SHAPE_ANGLE_DEG, type IsoInsert, type MillingInsert, type ShapeLetter } from './isoDesignation';

type Num = number | string | null | undefined;

// The insert_types columns the tooling pages read. Numeric columns may arrive as strings.
export interface InsertTypeRow {
	insert_type_id?: string;
	type_code?: string | null;
	iso_designation?: string | null;
	manufacturer?: string | null;
	manufacturer_id?: string | null;
	coating?: string | null;
	substrate?: string | null;
	material_class?: string | null;
	inserts_per_box?: Num;
	edge_count?: Num;
	nose_radius_mm?: Num;
	cutting_edge_length_mm?: Num;
	included_angle_deg?: Num;
	fixing_hole_diameter_mm?: Num;
}

export type TipMaterial = 'pcd' | 'cbn';

export interface InsertGeometry {
	shape: ShapeLetter | 'polygon' | 'rect'; // 'polygon' = fallback from edge_count; 'rect' = a milling insert (lengthMm x icMm)
	recognised: boolean;
	lengthMm: number | null; // rect only: the long side, the short side being icMm
	includedAngleDeg: number;
	cornerCount: number;
	cuttingCorners: number[];
	icMm: number;
	thicknessMm: number;
	noseRadiusMm: number;
	clearanceDeg: number;
	doubleSided: boolean;
	holeDiameterMm: number | null;
	holeCountersunk: boolean;
	edgesPerFace: number;
	tipMaterial: TipMaterial | null; // a brazed superhard tip (PCD, PCBN), else null
}

export interface InsertCorner {
	index: number;
	x: number;
	y: number; // nose-fillet centre
	bisectorDeg: number; // outward direction of the corner, [0, 360)
	angleDeg: number; // interior angle of the sharp corner
	cuts: boolean;
}

export interface InsertOutline {
	points: Array<[number, number]>; // closed (last != first), clockwise, fillets sampled every <= 10 degrees
	corners: InsertCorner[];
}

export const DEFAULT_IC_MM = 12.7;
export const DEFAULT_THICKNESS_MM = 4.76;
export const DEFAULT_NOSE_RADIUS_MM = 0.8;
const MAX_POLYGON_CORNERS = 24;
const MAX_ANGLE_OVERRIDE_DEG = 15;
const MAX_FILLET_STEP_DEG = 10;
const ROUND_STEP_DEG = 5;

const RAD = Math.PI / 180;

function num(v: Num): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) ? n : null;
}
const positive = (v: Num): number | null => {
	const n = num(v);
	return n !== null && n > 0 ? n : null;
};

// Typical fixing-hole diameter for an IC (mm), from common inserts; linear between the entries.
const HOLE_BY_IC: Array<[number, number]> = [
	[6.35, 2.8], [9.525, 4.4], [12.7, 5.16], [15.875, 6.35], [19.05, 7.93], [25.4, 9.12],
];
function typicalHole(ic: number): number {
	const first = HOLE_BY_IC[0];
	const last = HOLE_BY_IC[HOLE_BY_IC.length - 1];
	if (ic <= first[0]) return (ic * first[1]) / first[0];
	if (ic >= last[0]) return (ic * last[1]) / last[0];
	for (let i = 1; i < HOLE_BY_IC.length; i++) {
		const [x1, y1] = HOLE_BY_IC[i];
		const [x0, y0] = HOLE_BY_IC[i - 1];
		if (ic <= x1) return y0 + ((y1 - y0) * (ic - x0)) / (x1 - x0);
	}
	return last[1];
}

const isRhombic = (s: ShapeLetter | 'polygon'): boolean => s === 'C' || s === 'D' || s === 'V';

// Interior angles of the sharp polygon, starting at corner 0, and which vertices are corners.
interface Plan { angles: number[]; corner: boolean[]; startDeg: number }
function polygonPlan(shape: ShapeLetter | 'polygon', cornerCount: number, includedAngleDeg: number): Plan {
	if (isRhombic(shape)) {
		const a = includedAngleDeg;
		return { angles: [a, 180 - a, a, 180 - a], corner: [true, true, true, true], startDeg: 90 };
	}
	if (shape === 'W') {
		return { angles: [80, 160, 80, 160, 80, 160], corner: [true, false, true, false, true, false], startDeg: 90 };
	}
	const n = shape === 'T' ? 3 : shape === 'S' ? 4 : cornerCount;
	return {
		angles: Array.from({ length: n }, () => ((n - 2) * 180) / n),
		corner: Array.from({ length: n }, () => true),
		startDeg: n === 4 ? 135 : 90, // squares sit flat
	};
}

// Edge length / IC of the sharp polygon, to turn cutting_edge_length_mm into an IC.
function edgeOverIc(shape: ShapeLetter | 'polygon', includedAngleDeg: number, cornerCount: number): number {
	if (shape === 'R') return 1;
	if (isRhombic(shape)) return 1 / Math.sin(includedAngleDeg * RAD);
	if (shape === 'W') return (1 / Math.tan(40 * RAD) + 1 / Math.tan(80 * RAD)) / 2;
	const n = shape === 'T' ? 3 : shape === 'S' ? 4 : cornerCount;
	return Math.tan(Math.PI / n);
}

// A tipped insert is named in the type's substrate, its type code or its ISO designation (the suffix, such as
// "CCGW 09T3 04-PCD"). `material_class` is the ISO 513 group letter (P, M, K, N, S, H), not the tip, so it is not read.
const letters = String.raw`(?<![a-z])`;
const PCD_RE = new RegExp(`${letters}(pcd|diamond)(?![a-z])`, 'i');
const CBN_RE = new RegExp(`${letters}(pcbn|cbn)(?![a-z])`, 'i');
export function detectTipMaterial(type: InsertTypeRow | null): TipMaterial | null {
	const text = [type?.substrate, type?.type_code, type?.iso_designation].filter((v): v is string => typeof v === 'string').join(' | ');
	if (PCD_RE.test(text)) return 'pcd';
	if (CBN_RE.test(text)) return 'cbn';
	return null;
}

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

function resolveMilling(type: InsertTypeRow | null, mill: MillingInsert): InsertGeometry {
	const edgeCountRaw = positive(type?.edge_count);
	const edgeCount = edgeCountRaw === null ? null : Math.round(edgeCountRaw);
	let cuttingCorners = [0, 2];
	if (edgeCount !== null && edgeCount < cuttingCorners.length) cuttingCorners = cuttingCorners.slice(0, edgeCount);
	const nose = num(type?.nose_radius_mm);
	return {
		shape: 'rect', recognised: true, lengthMm: mill.lengthMm, includedAngleDeg: 90, cornerCount: 4, cuttingCorners,
		icMm: mill.widthMm, thicknessMm: mill.thicknessMm,
		noseRadiusMm: nose !== null && nose >= 0 ? nose : mill.noseRadiusMm,
		clearanceDeg: 0, doubleSided: edgeCount !== null && edgeCount >= 2 * cuttingCorners.length,
		holeDiameterMm: positive(type?.fixing_hole_diameter_mm) ?? mill.holeDiameterMm, holeCountersunk: true,
		edgesPerFace: cuttingCorners.length, tipMaterial: detectTipMaterial(type),
	};
}

export function resolveInsertGeometry(type: InsertTypeRow | null): InsertGeometry {
	// iso_designation is often empty; the ISO code is then usually the start of type_code ("CNMG 12 04 08-SM H13A").
	const iso: IsoInsert | null = parseIsoDesignation(type?.iso_designation) ?? parseIsoDesignation(type?.type_code);
	if (!iso) {
		const mill = parseMillingDesignation(type?.iso_designation) ?? parseMillingDesignation(type?.type_code);
		if (mill) return resolveMilling(type, mill);
	}
	const edgeCountRaw = positive(type?.edge_count);
	const edgeCount = edgeCountRaw === null ? null : Math.round(edgeCountRaw);

	const shape: ShapeLetter | 'polygon' = iso ? iso.shape : 'polygon';
	let cornerCount: number;
	let cuttingCorners: number[];
	let includedAngleDeg: number;

	if (iso && iso.shape === 'R') {
		const faces = iso.doubleSided ? 2 : 1;
		cornerCount = Math.min(MAX_POLYGON_CORNERS, Math.max(1, edgeCount === null ? 4 : Math.round(edgeCount / faces)));
		cuttingCorners = range(cornerCount);
		includedAngleDeg = SHAPE_ANGLE_DEG.R;
	} else if (iso) {
		const nominal = SHAPE_ANGLE_DEG[iso.shape];
		const override = positive(type?.included_angle_deg);
		// The shape letter fixes the angle; an override only nudges it (a live CNMG row said 0.010, which drew a needle).
		includedAngleDeg = isRhombic(iso.shape) && override !== null && Math.abs(override - nominal) <= MAX_ANGLE_OVERRIDE_DEG ? override : nominal;
		cornerCount = { C: 4, D: 4, V: 4, S: 4, T: 3, W: 3 }[iso.shape as Exclude<ShapeLetter, 'R'>];
		cuttingCorners = isRhombic(iso.shape) ? [0, 2] : range(cornerCount);
	} else {
		cornerCount = edgeCount !== null && edgeCount >= 3 ? Math.min(edgeCount, MAX_POLYGON_CORNERS) : 4;
		cuttingCorners = range(cornerCount);
		includedAngleDeg = ((cornerCount - 2) * 180) / cornerCount;
	}

	// A type with fewer edges than the shape has cutting corners (a one-edge CCGW tip): only the first
	// edge_count corners cut, counted from A, and the insert is single-sided.
	if (shape !== 'R' && edgeCount !== null && edgeCount < cuttingCorners.length) cuttingCorners = cuttingCorners.slice(0, edgeCount);

	const edgeLength = positive(type?.cutting_edge_length_mm);
	const icMm = edgeLength !== null
		? edgeLength / edgeOverIc(shape, includedAngleDeg, cornerCount)
		: (iso?.icMm ?? DEFAULT_IC_MM);

	const hole = iso?.hole ?? 'none';
	const holeOverride = positive(type?.fixing_hole_diameter_mm);
	const holeDiameterMm = holeOverride ?? (hole !== 'none' ? typicalHole(icMm) : null);

	const doubleSided = edgeCount !== null ? edgeCount >= 2 * cuttingCorners.length : (iso?.doubleSided ?? false);

	return {
		shape,
		recognised: iso !== null,
		lengthMm: null,
		includedAngleDeg,
		cornerCount,
		cuttingCorners,
		icMm,
		thicknessMm: iso?.thicknessMm ?? DEFAULT_THICKNESS_MM,
		noseRadiusMm: (() => {
			const o = num(type?.nose_radius_mm);
			return o !== null && o >= 0 ? o : (iso?.noseRadiusMm ?? DEFAULT_NOSE_RADIUS_MM);
		})(),
		clearanceDeg: iso?.clearanceDeg ?? 0,
		doubleSided,
		holeDiameterMm,
		holeCountersunk: hole === 'countersunk',
		edgesPerFace: cuttingCorners.length,
		tipMaterial: detectTipMaterial(type),
	};
}

const norm360 = (deg: number): number => ((deg % 360) + 360) % 360;

function roundOutline(geom: InsertGeometry): InsertOutline {
	const r = geom.icMm / 2;
	const steps = Math.round(360 / ROUND_STEP_DEG);
	const points: Array<[number, number]> = [];
	for (let i = 0; i < steps; i++) {
		const a = (90 - (i * 360) / steps) * RAD;
		points.push([r * Math.cos(a), r * Math.sin(a)]);
	}
	const corners: InsertCorner[] = range(geom.cornerCount).map((i) => {
		const deg = 90 - (i * 360) / geom.cornerCount;
		return {
			index: i, x: r * Math.cos(deg * RAD), y: r * Math.sin(deg * RAD),
			bisectorDeg: norm360(deg), angleDeg: 180, cuts: geom.cuttingCorners.includes(i),
		};
	});
	return { points, corners };
}

// A rectangle (a milling insert) with all four corners filleted, clockwise from the top-right corner.
function rectOutline(geom: InsertGeometry): InsertOutline {
	const hl = (geom.lengthMm ?? geom.icMm) / 2;
	const hw = geom.icMm / 2;
	const re = Math.min(Math.max(geom.noseRadiusMm, 0), hw * 0.99);
	const centres: Array<[number, number, number]> = [[hl - re, hw - re, 45], [hl - re, re - hw, 315], [re - hl, re - hw, 225], [re - hl, hw - re, 135]];
	const points: Array<[number, number]> = [];
	const corners: InsertCorner[] = [];
	centres.forEach(([cx, cy, bisector], index) => {
		if (re <= 0) points.push([cx, cy]);
		else {
			const segments = Math.ceil(90 / MAX_FILLET_STEP_DEG - 1e-9);
			for (let s = 0; s <= segments; s++) {
				const a = (bisector + 45 - (90 * s) / segments) * RAD; // clockwise
				points.push([cx + re * Math.cos(a), cy + re * Math.sin(a)]);
			}
		}
		// The bearing from the centre to the fillet centre, not the true 45 degree bisector: the pages step out from the middle along it.
		corners.push({ index, x: cx, y: cy, bisectorDeg: norm360((Math.atan2(cy, cx) * 180) / Math.PI), angleDeg: 90, cuts: geom.cuttingCorners.includes(index) });
	});
	return { points, corners };
}

export function insertOutline(geom: InsertGeometry): InsertOutline {
	if (geom.shape === 'R') return roundOutline(geom);
	if (geom.shape === 'rect') return rectOutline(geom);
	const plan = polygonPlan(geom.shape, geom.cornerCount, geom.includedAngleDeg);
	const r = geom.icMm / 2;
	const re = Math.min(Math.max(geom.noseRadiusMm, 0), r * 0.99);
	const points: Array<[number, number]> = [];
	const corners: InsertCorner[] = [];
	let theta = plan.startDeg;
	for (let k = 0; k < plan.angles.length; k++) {
		const ext = 180 - plan.angles[k]; // exterior angle at this vertex
		const centreDist = (r - re) / Math.cos((ext / 2) * RAD);
		const cx = centreDist * Math.cos(theta * RAD);
		const cy = centreDist * Math.sin(theta * RAD);
		if (re <= 0) {
			points.push([cx, cy]);
		} else {
			const segments = Math.max(1, Math.ceil(ext / MAX_FILLET_STEP_DEG - 1e-9));
			for (let s = 0; s <= segments; s++) {
				const a = (theta + ext / 2 - (ext * s) / segments) * RAD; // clockwise
				points.push([cx + re * Math.cos(a), cy + re * Math.sin(a)]);
			}
		}
		if (plan.corner[k]) {
			const index = corners.length;
			corners.push({
				index, x: cx, y: cy, bisectorDeg: norm360(theta), angleDeg: plan.angles[k],
				cuts: geom.cuttingCorners.includes(index),
			});
		}
		const next = plan.angles[(k + 1) % plan.angles.length];
		theta -= ext / 2 + (180 - next) / 2;
	}
	return { points, corners };
}
