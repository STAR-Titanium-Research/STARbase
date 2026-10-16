// The geometry numbers of the viewer: how big the surface is in the scene, the height range the colour ramp
// spans, the vertical exaggeration (a log slider), the camera framing and the legend's text. Pure.

import type { GridStats, ScanMeta } from './gridData';

export interface ScanLayout {
	/** Lateral size of the scanned area in micrometres. */
	extentXUm: number;
	extentZUm: number;
	/** Scene size: the longer side is 1, so the camera framing does not depend on the scan's units. */
	sizeX: number;
	sizeZ: number;
	/** Scene units per micrometre (the same for height and for the plane, so shapes keep their proportions). */
	umToScene: number;
	/** False when the file does not state a pixel pitch: the plane is then drawn with square cells. */
	pitchKnown: boolean;
}

export function scanLayout(meta: ScanMeta): ScanLayout {
	const pitchKnown = meta.pixelPitchXUm !== null && meta.pixelPitchYUm !== null;
	const px = meta.pixelPitchXUm ?? 1;
	const py = meta.pixelPitchYUm ?? px;
	// A cell is a sample point, so n cells span n - 1 pitches.
	const extentXUm = (meta.width - 1) * px;
	const extentZUm = (meta.height - 1) * py;
	const longest = Math.max(extentXUm, extentZUm);
	const umToScene = 1 / longest;
	return { extentXUm, extentZUm, sizeX: extentXUm * umToScene, sizeZ: extentZUm * umToScene, umToScene, pitchKnown };
}

export interface HeightRange {
	min: number;
	max: number;
}

/** The range the legend and the colour ramp span: the file's own statement, else what the grid holds. Never empty. */
export function heightRange(meta: ScanMeta, stats: GridStats): HeightRange {
	if (meta.zMinUm !== null && meta.zMaxUm !== null && meta.zMaxUm > meta.zMinUm) return { min: meta.zMinUm, max: meta.zMaxUm };
	if (stats.valid > 0 && stats.max > stats.min) return { min: stats.min, max: stats.max };
	const mid = stats.valid > 0 ? stats.min : (meta.zMinUm ?? 0);
	return { min: mid - 0.5, max: mid + 0.5 }; // a flat or empty surface: any non-zero span draws it flat
}

export const EXAG_MIN = 1;
export const EXAG_MAX = 1000;
export const SLIDER_STEPS = 1000;

const clampExag = (x: number) => Math.min(EXAG_MAX, Math.max(EXAG_MIN, x));

/** The slider (0..SLIDER_STEPS) is logarithmic: equal steps are equal factors, 1x to 1000x. */
export function sliderToExaggeration(step: number): number {
	const t = Math.min(1, Math.max(0, step / SLIDER_STEPS));
	return clampExag(Math.pow(EXAG_MAX / EXAG_MIN, t) * EXAG_MIN);
}

export function exaggerationToSlider(x: number): number {
	return Math.round((Math.log(clampExag(x) / EXAG_MIN) / Math.log(EXAG_MAX / EXAG_MIN)) * SLIDER_STEPS);
}

/**
 * Where the exaggeration starts: enough that the relief reads at about a tenth of the scan's size, but never
 * below 1x (true scale) and never past the slider. A rough scan (relief about its own size) starts at 1x.
 */
export function defaultExaggeration(layout: ScanLayout, range: HeightRange): number {
	const reliefUm = range.max - range.min;
	const lateralUm = Math.max(layout.extentXUm, layout.extentZUm);
	if (!(reliefUm > 0) || !(lateralUm > 0)) return 1;
	const x = clampExag((0.1 * lateralUm) / reliefUm);
	return x < 10 ? Math.round(x * 10) / 10 : Math.round(x); // 3.4x, but 120x
}

export function formatExaggeration(x: number): string {
	return `${x < 10 ? Math.round(x * 10) / 10 : Math.round(x)}×`;
}

export interface CameraFrame {
	distance: number;
	minDistance: number;
	maxDistance: number;
	near: number;
	far: number;
	/** Where the camera starts, from straight above (polar) and around the vertical (azimuth), in degrees. */
	polarDeg: number;
	azimuthDeg: number;
	/** The orbit's polar limits in degrees: never under the surface, never exactly overhead (gimbal flip). */
	minPolarDeg: number;
	maxPolarDeg: number;
}

export const FOV_DEG = 35;

/** Distance at which a sphere of `radius` fits a view of this aspect (width / height). */
export function fitDistance(radius: number, fovDeg = FOV_DEG, aspect = 1): number {
	const v = (fovDeg * Math.PI) / 180;
	const h = 2 * Math.atan(Math.tan(v / 2) * Math.max(aspect, 0.1));
	return radius / Math.sin(Math.min(v, h) / 2);
}

/**
 * The camera for a surface of this layout, drawn with `exaggeration`. Zoom is limited to between a close look
 * (a fifth of the fit distance) and well back (three times it).
 */
export function frameCamera(layout: ScanLayout, range: HeightRange, exaggeration: number, aspect = 1): CameraFrame {
	const relief = (range.max - range.min) * layout.umToScene * exaggeration;
	const radius = 0.5 * Math.hypot(layout.sizeX, layout.sizeZ, relief);
	const distance = fitDistance(radius, FOV_DEG, aspect) * 1.05;
	return {
		distance,
		minDistance: distance / 5,
		maxDistance: distance * 3,
		near: distance / 100,
		far: distance * 10,
		polarDeg: 52,
		azimuthDeg: 28,
		minPolarDeg: 4,
		maxPolarDeg: 86,
	};
}

// ---- text ----------------------------------------------------------------------------------------------

/** A height in micrometres, with the precision the size of the number deserves. */
export function formatMicrometres(v: number | null | undefined): string {
	if (typeof v !== 'number' || !Number.isFinite(v)) return '–';
	const a = Math.abs(v);
	const text = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
	return `${text.replace('-', '−')} µm`;
}

/** "5.2 µm", or "5.2 × 4.8 µm" when the two pitches differ. */
export function pitchText(meta: ScanMeta): string {
	const x = meta.pixelPitchXUm;
	const y = meta.pixelPitchYUm;
	if (x === null || y === null) return 'not stated in the file';
	const f = (n: number) => (n >= 10 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, '');
	return Math.abs(x - y) < 1e-6 * Math.max(x, y) ? `${f(x)} µm` : `${f(x)} × ${f(y)} µm`;
}

/** "1024 × 768 cells", with the source size when the grid was decimated from a larger one. */
export function sizeText(meta: ScanMeta): string {
	const grid = `${meta.width} × ${meta.height} cells`;
	const same = meta.sourceWidth === meta.width && meta.sourceHeight === meta.height;
	return meta.sourceWidth && meta.sourceHeight && !same ? `${grid} (from ${meta.sourceWidth} × ${meta.sourceHeight})` : grid;
}
