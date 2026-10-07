// A gauge full-scale that does not breathe with the signal (#67). The RPM meter's scale used to be
// max(target * 1.25, rpm * 1.1, 100), recomputed every frame — so with no target (a replay whose
// operation has no spindle speed) the scale tracked RPM noise itself, the arc sat pinned near the
// same fraction while its scale jumped, and the sparkline was renormalised to its own max every
// frame. Here the scale snaps to a "nice" value, grows at once when needed, and shrinks only after
// the lower value has held for a while.

const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest nice number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k) at or above v. */
export function niceCeil(v: number): number {
	if (!(v > 0) || !Number.isFinite(v)) return 1;
	const mag = Math.pow(10, Math.floor(Math.log10(v)));
	const r = v / mag;
	// A hair of tolerance so 1500 stays 1500 rather than rounding up past float noise.
	for (const n of NICE) if (r <= n * (1 + 1e-9)) return n * mag;
	return 10 * mag;
}

export interface StableMax {
	/** Feed the value the scale must cover at `now` (ms); returns the scale to draw with. */
	update(want: number, now: number): number;
	readonly value: number;
	reset(): void;
}

export function createStableMax(o: { floor?: number; shrinkAfterMs?: number } = {}): StableMax {
	const floor = o.floor ?? 100;
	const shrinkAfterMs = o.shrinkAfterMs ?? 3000;
	let cur = niceCeil(floor);
	let lowSince: number | null = null;   // when the wanted scale first dropped below cur
	let lowMax = 0;                       // the largest scale wanted since then
	return {
		update(want, now) {
			const nice = niceCeil(Math.max(floor, Number.isFinite(want) ? want : 0));
			if (nice > cur) { cur = nice; lowSince = null; return cur; }
			if (nice === cur) { lowSince = null; return cur; }
			if (lowSince === null) { lowSince = now; lowMax = nice; return cur; }
			lowMax = Math.max(lowMax, nice);
			if (now - lowSince >= shrinkAfterMs) { cur = lowMax; lowSince = null; }
			return cur;
		},
		get value() { return cur; },
		reset() { cur = niceCeil(floor); lowSince = null; lowMax = 0; },
	};
}
