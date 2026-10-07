// Live clipping / rail warning (R5). The recorder latches, per cut, which of the 8 dyno sensor
// channels reached full scale (backend/app/clipping.py: peak >= 99 % of gain x analog full scale,
// the same test finalize uses for `channels_ranging.clipped`) and streams them as indices 0-7 in
// raw-file order. A railed channel has lost its peaks; the only fix is a wider amp range, and the
// amp can't be re-ranged mid-cut, so the message is about the NEXT cut.

/** Channel names for the indices the backend sends (0-7), in raw-file column order. */
export const RAIL_CHANNELS = ['Fx1', 'Fx2', 'Fy1', 'Fy2', 'Fz1', 'Fz2', 'Fz3', 'Fz4'] as const;

/** A wire value as a sorted list of distinct valid channel indices. Anything else is dropped. */
export function parseRailed(v: unknown): number[] {
	if (!Array.isArray(v)) return [];
	const out = new Set<number>();
	for (const x of v) {
		if (Number.isInteger(x) && x >= 0 && x < RAIL_CHANNELS.length) out.add(x as number);
	}
	return [...out].sort((a, b) => a - b);
}

/** Names of the railed channels, for the badges and the banner. */
export function railedNames(idx: readonly number[]): string[] {
	return idx.filter((i) => i >= 0 && i < RAIL_CHANNELS.length).map((i) => RAIL_CHANNELS[i]);
}

export function isRailed(idx: readonly number[], channel: string): boolean {
	return idx.includes((RAIL_CHANNELS as readonly string[]).indexOf(channel));
}

/** The banner sentence, or null when nothing has railed. */
export function railBannerText(idx: readonly number[]): string | null {
	const names = railedNames(idx);
	if (!names.length) return null;
	return `${names.map((n) => `Ch ${n}`).join(', ')} railed - re-range before the next cut`;
}

/** The railed set the badges show. Record mode only: Playback (and a replayed cut generally) is an
 *  archived cut that never railed on this rig, so a badge there would be a false alarm. */
export function shownRailed(mode: 'record' | 'playback', idx: readonly number[]): readonly number[] {
	return mode === 'record' ? idx : [];
}
