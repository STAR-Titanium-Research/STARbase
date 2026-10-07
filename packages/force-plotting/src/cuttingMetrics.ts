// Cutting metrics for the Plot dashboard's "Cutting metrics" card: resultant force, Fc/Ff/Fp,
// cutting speed, cutting power and specific cutting energy over the crop window. Pure functions;
// every metric is a value or "unavailable" with a reason. Formulas, units and the axis-mapping
// assumption: docs/superpowers/specs/2026-10-06-cutting-metrics-design.md.
import type { SignalStats } from './signalStats';

export type ForceAxis = 'Fx' | 'Fy' | 'Fz';
export type CutRole = 'Fc' | 'Ff' | 'Fp';
/** Which dynamometer axis carries each ISO 3002 force (Fc main cutting, Ff feed, Fp passive). */
export type AxisMap = Record<CutRole, ForceAxis>;
export type OpKind = 'turning' | 'milling' | 'unknown';

/** The owner's standard: Fc = Fx, Fp = Fz (so Ff = Fy). It can change with workholding and the
 * machining operation, hence the per-subtype memory below (spec, "Axis mapping"). */
export const DEFAULT_AXIS_MAP: AxisMap = { Fc: 'Fx', Ff: 'Fy', Fp: 'Fz' };

/** All six assignments, for the card's select. Key is `Fc/Ff/Fp` axes, e.g. "Fz/Fx/Fy". */
export const AXIS_MAPS: { key: string; map: AxisMap }[] = (() => {
	const ax: ForceAxis[] = ['Fx', 'Fy', 'Fz'];
	const out: { key: string; map: AxisMap }[] = [];
	for (const c of ax) for (const f of ax) for (const p of ax) {
		if (c === f || c === p || f === p) continue;
		out.push({ key: axisMapKey({ Fc: c, Ff: f, Fp: p }), map: { Fc: c, Ff: f, Fp: p } });
	}
	return out;
})();

export function axisMapKey(m: AxisMap): string { return `${m.Fc}/${m.Ff}/${m.Fp}`; }
export function parseAxisMap(key: string | null | undefined): AxisMap {
	return AXIS_MAPS.find((a) => a.key === key)?.map ?? DEFAULT_AXIS_MAP;
}

/** localStorage key of the per-subtype choice: a JSON object `{ [subtype]: "Fc/Ff/Fp" }`. */
export const AXIS_MAP_BY_SUBTYPE_KEY = 'd1.cuttingAxisMapBySubtype';
/** The old single-value key, chosen against the previous default; removed on first load. */
export const LEGACY_AXIS_MAP_KEY = 'd1.cuttingAxisMap';
const DEFAULT_SUBTYPE_KEY = 'default';

/** Fc = .., Ff = .., Fp = .. for display. */
export function formatAxisMap(m: AxisMap): string {
	return `Fc = ${m.Fc}, Ff = ${m.Ff}, Fp = ${m.Fp}`;
}

/** Storage key of an operation subtype: trimmed, upper-cased; empty is "default". Any other
 * subtype, recognised or not, gets its own entry. */
export function subtypeMapKey(subtype: string | null | undefined): string {
	return (subtype ?? '').trim().toUpperCase() || DEFAULT_SUBTYPE_KEY;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStorage = (): StorageLike | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/** Reads the stored map defensively: anything that is not an object of valid mapping keys is dropped. */
export function readAxisMapsBySubtype(storage: StorageLike | null = defaultStorage()): Record<string, string> {
	const out: Record<string, string> = {};
	if (!storage) return out;
	try {
		const raw = storage.getItem(AXIS_MAP_BY_SUBTYPE_KEY);
		if (!raw) return out;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === 'string' && AXIS_MAPS.some((a) => a.key === v)) out[k] = v;
		}
	} catch { /* corrupt or inaccessible storage: use defaults */ }
	return out;
}

/** The mapping for a subtype: its stored choice, else the default. */
export function resolveAxisMap(subtype: string | null | undefined, storage: StorageLike | null = defaultStorage()): AxisMap {
	return parseAxisMap(readAxisMapsBySubtype(storage)[subtypeMapKey(subtype)]);
}

/** Remembers `map` for `subtype`; other subtypes' entries are kept. Never throws. */
export function writeAxisMapForSubtype(subtype: string | null | undefined, map: AxisMap, storage: StorageLike | null = defaultStorage()): void {
	if (!storage) return;
	try {
		const all = readAxisMapsBySubtype(storage);
		all[subtypeMapKey(subtype)] = axisMapKey(map);
		storage.setItem(AXIS_MAP_BY_SUBTYPE_KEY, JSON.stringify(all));
	} catch { /* ignore */ }
}

/** Drops the pre-per-subtype single key (it was chosen against the old default). */
export function removeLegacyAxisMap(storage: StorageLike | null = defaultStorage()): void {
	try { storage?.removeItem(LEGACY_AXIS_MAP_KEY); } catch { /* ignore */ }
}

/** `MT*` turning, `MM*` milling (the rule force-app-web's opTypeCategory uses); anything else unknown. */
export function opKindFromSubtype(subtype: string | null | undefined): OpKind {
	const s = (subtype ?? '').trim().toUpperCase();
	if (s.startsWith('MT')) return 'turning';
	if (s.startsWith('MM')) return 'milling';
	return 'unknown';
}

/** Turning operations whose diameter shrinks along the cut, so vc is not constant: facing (MT-F),
 * grooving (MT-G) and parting (MT-P), the cuts the dashboard's spiral model describes. OD turning
 * (MT-O), roughing (MT-R), boring (MT-B), threading (MT-H) and drilling (MT-D) run at a constant
 * diameter. Spelled-out codes ("MT-FACE") are accepted as well. */
const SPIRAL_SUBTYPES = new Set(['MT-F', 'MT-FACE', 'MT-FACING', 'MT-G', 'MT-GROOVE', 'MT-GROOVING', 'MT-P', 'MT-PART', 'MT-PARTING']);
export function usesSpiralDiameter(subtype: string | null | undefined): boolean {
	return SPIRAL_SUBTYPES.has((subtype ?? '').trim().toUpperCase());
}

export interface Metric { value: number | null; reason?: string }
const ok = (value: number): Metric => ({ value });
const na = (reason: string): Metric => ({ value: null, reason });
const naPair = (reason: string) => ({ mean: na(reason), peak: na(reason) });
const pos = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

export interface CuttingInputs {
	stats: Pick<SignalStats, 'axes' | 'rpm' | 'windowSec' | 'resultant' | 'cacheCropStartSec'>;
	axisMap: AxisMap;
	opKind: OpKind;
	/** Facing, grooving or parting (usesSpiralDiameter): D shrinks along the cut. False keeps the
	 * diameter constant, as for OD turning, boring or threading. */
	spiral: boolean;
	/** Diameter (mm) at the spiral origin, i.e. the dashboard's Diameter control. */
	diameterMm: number | null | undefined;
	/** Feed (mm/rev) of the operation: kc. */
	feedMmPerRev: number | null | undefined;
	/** Feed the spiral model uses (the dashboard's geometry feed, `editFeed`), so D_mid agrees with
	 * the radial axis of the plots. Defaults to `feedMmPerRev`. */
	spiralFeedMmPerRev?: number | null;
	/** Time (s) where the spiral puts D: the active crop start, i.e. the saved crop override when
	 * there is one. Defaults to the cache's crop start. */
	spiralOriginSec?: number | null;
	apMm: number | null | undefined;
}

export interface CuttingMetrics {
	resultant: { mean: Metric; peak: Metric };       // N
	Fc: { mean: Metric; peak: Metric };              // N (mapped axis)
	Ff: { mean: Metric; peak: Metric };
	Fp: { mean: Metric; peak: Metric };
	diameterMidMm: Metric;                           // mm, diameter at the window midpoint
	vcMPerMin: Metric;                               // m/min
	pcW: Metric;                                     // W
	kcMPa: Metric;                                   // N/mm² = MPa
	axisMap: AxisMap;
}

/** Diameter at the window midpoint of a facing spiral: D − 2·f·n·(t_mid − t_origin)/60. */
export function midWindowDiameter(
	diameterMm: number, feedMmPerRev: number, rpm: number, tMidMinusCropSec: number,
): number {
	return diameterMm - 2 * feedMmPerRev * rpm * tMidMinusCropSec / 60;
}

export function computeCuttingMetrics(inp: CuttingInputs): CuttingMetrics {
	const { stats, axisMap, opKind } = inp;
	const turning = opKind === 'turning';
	const notTurning = opKind === 'milling'
		? 'milling operation: turning geometry assumed'
		: 'operation type unknown (subtype is not MT…)';

	const force = (role: CutRole): { mean: Metric; peak: Metric } => {
		if (!turning) return naPair(notTurning);
		const a = stats.axes[axisMap[role]];
		if (!a || !a.n) return naPair('no samples in the window');
		return { mean: ok(Math.abs(a.mean)), peak: ok(Math.max(Math.abs(a.min), Math.abs(a.max))) };
	};
	const Fc = force('Fc'), Ff = force('Ff'), Fp = force('Fp');

	const hasWin = stats.axes.Fx.n > 0;
	const resultant = hasWin
		? { mean: ok(stats.resultant.mean), peak: ok(stats.resultant.peak) }
		: naPair('no samples in the window');

	const rpm = stats.rpm.mean;
	let diameterMid: Metric, vc: Metric;
	if (!turning) diameterMid = vc = na(notTurning);
	else if (!pos(inp.diameterMm)) diameterMid = vc = na('diameter missing');
	else if (!pos(rpm)) diameterMid = vc = na('RPM is zero in this window');
	else {
		const tMid = (stats.windowSec[0] + stats.windowSec[1]) / 2;
		const origin = inp.spiralOriginSec != null && Number.isFinite(inp.spiralOriginSec) ? inp.spiralOriginSec : stats.cacheCropStartSec;
		const spiralFeed = inp.spiralFeedMmPerRev !== undefined ? inp.spiralFeedMmPerRev : inp.feedMmPerRev;
		// Constant D unless this is facing/grooving/parting. Without a feed the shrinkage is
		// unknowable; fall back to the origin diameter.
		const f = inp.spiral && pos(spiralFeed) ? spiralFeed : 0;
		const d = midWindowDiameter(inp.diameterMm, f, rpm, tMid - origin);
		if (!(d > 0)) diameterMid = vc = na('window lies beyond the disc centre (check diameter and crop)');
		else { diameterMid = ok(d); vc = ok(Math.PI * d * rpm / 1000); }
	}

	let pc: Metric, kc: Metric;
	if (Fc.mean.value == null) pc = kc = na(Fc.mean.reason!);
	else {
		pc = vc.value == null ? na(vc.reason!) : ok(Fc.mean.value * vc.value / 60);
		if (!pos(inp.feedMmPerRev)) kc = na('feed not recorded');
		else if (!pos(inp.apMm)) kc = na('depth of cut not recorded');
		else kc = ok(Fc.mean.value / (inp.apMm * inp.feedMmPerRev));
	}

	return { resultant, Fc, Ff, Fp, diameterMidMm: diameterMid, vcMPerMin: vc, pcW: pc, kcMPa: kc, axisMap };
}
