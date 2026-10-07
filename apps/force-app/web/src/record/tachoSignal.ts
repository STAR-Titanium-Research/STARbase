// What the "Tacho" channel means in each place the Record page can plot it, and what to say when
// there is nothing to plot (#108 made Tacho the default bottom panel, so all three must work).
//
//   live recording   the raw tacho pulse train, a min/max envelope per bin (D1LF sub-channel 8).
//                    Real data, in volts.
//   finished cut     live_cache.bin has NO raw tacho column: it stores the derived per-sample `rpm`.
//                    So Tacho is drawn as that RPM series. A force-app capture whose tacho gave no
//                    timable pulse pair has rpm == 0 throughout (finalize.py writes zeros rather
//                    than a made-up speed), which counts as "no tacho" here.
//   replay           the playback engine fills the live trace from that same cache, so it also gets
//                    RPM, or nothing at all when the cache has none.
//
// A plot must never draw a flat zero line for a channel that was not measured, nor leave an empty
// plot under a legend entry: it says "no tacho" instead.
import type { Cache } from '@d1/force-plotting';

export type TachoKind = 'signal' | 'rpm' | 'none';

export const TACHO = 'Tacho';
export const FORCE_AXES = ['Fx', 'Fy', 'Fz'] as const;

const measured = new WeakMap<object, boolean>();
/** True when a cache's rpm series holds a real measurement: at least one finite, non-zero sample. */
export function hasMeasuredRpm(c: Pick<Cache, 'rpm'>): boolean {
	const hit = measured.get(c);
	if (hit !== undefined) return hit;
	let ok = false;
	const r = c.rpm;
	if (r) for (let i = 0; i < r.length; i++) { const v = r[i]; if (Number.isFinite(v) && v !== 0) { ok = true; break; } }
	measured.set(c, ok);
	return ok;
}

/** How a cached recording (finished or replayed) can show Tacho. */
export function cacheTachoKind(c: Pick<Cache, 'rpm'>): 'rpm' | 'none' {
	return hasMeasuredRpm(c) ? 'rpm' : 'none';
}

/** Legend text for a channel: Tacho says which quantity it is, the rest show their own name. */
export function channelLabel(key: string, kind: TachoKind): string {
	if (key !== TACHO) return key;
	return kind === 'rpm' ? 'Tacho (RPM)' : kind === 'signal' ? 'Tacho (V)' : 'Tacho';
}

/** Y-axis title for a set of selected channels. Mixed sets name both quantities. */
export function axisLabel(channels: readonly string[], kind: TachoKind): string {
	const hasTacho = channels.includes(TACHO);
	const hasOther = channels.some((k) => k !== TACHO);
	const tacho = kind === 'rpm' ? 'RPM' : 'Tacho (V)';
	if (hasTacho && !hasOther) return kind === 'none' ? 'Tacho' : tacho;
	if (hasTacho && kind !== 'none') return `Force (N) / ${tacho}`;
	return 'Force (N)';
}

/** One line telling the operator why Tacho cannot be drawn, or null when nothing is wrong. */
export function tachoMissingNote(channels: readonly string[], kind: TachoKind, tachoOk?: boolean | null): string | null {
	if (!channels.includes(TACHO)) return null;
	if (kind === 'none') return 'No tacho signal in this recording';
	if (kind === 'signal' && tachoOk === false) return 'No readable tacho pulses';
	return null;
}

export interface FinishedPlotModel {
	/** Summed force axes present in the cache, in the order asked for. Drawn on the left axis. */
	force: (readonly [string, Float32Array])[];
	/** The cache's RPM series when Tacho is selected and was measured, else null. */
	rpm: Float32Array | null;
	/** Why selected channels are not drawn (no tacho, per-sensor channels the cache does not hold). */
	notes: string[];
}

/** Which of the selected channels a finished-cut cache can draw, and why the others cannot. */
export function finishedPlotModel(cache: Pick<Cache, 'Fx' | 'Fy' | 'Fz' | 'rpm'>, channels: readonly string[]): FinishedPlotModel {
	const force: (readonly [string, Float32Array])[] = [];
	const notes: string[] = [];
	const unsupported: string[] = [];
	let wantTacho = false;
	for (const k of channels) {
		if (k === 'Fx' || k === 'Fy' || k === 'Fz') {
			const a = cache[k];
			if (a && a.length > 0) force.push([k, a] as const);
		} else if (k === TACHO) wantTacho = true;
		else unsupported.push(k);
	}
	const rpm = wantTacho && hasMeasuredRpm(cache) ? cache.rpm : null;
	if (wantTacho && !rpm) notes.push('No tacho signal in this recording');
	if (unsupported.length) notes.push(`${unsupported.join(', ')}: not stored in a finished recording (summed axes and Tacho only)`);
	return { force, rpm, notes };
}
