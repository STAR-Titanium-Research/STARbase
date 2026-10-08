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

// The sparkline's own y-domain (#188). It used to share the gauge's scale (target * 1.25), so for
// most of a CSS cut, where RPM is a small fraction of the target, 50 RPM at a 3000 target filled
// under 2 % of the box and read as a flat line. The domain now follows the history shown: its span
// is the history's range plus padding, never below a minimum (so steady-state noise does not fill
// the box), snapped and made sticky with createStableMax; and it is only moved when the data
// leaves it, so the curve does not slide around with every frame.

export interface SparkDomain { lo: number; hi: number }

export interface SparkDomainTracker {
	/** Feed the visible history at `now` (ms); returns the y-domain to draw it in (empty history: the minimum span from 0). */
	update(values: readonly number[], now: number): SparkDomain;
	reset(): void;
}

export function createSparkDomain(o: { minSpan?: number; pad?: number; relMin?: number } = {}): SparkDomainTracker {
	const minSpan = o.minSpan ?? 20;
	const pad = o.pad ?? 1.2;        // span wanted = data range x pad
	const relMin = o.relMin ?? 0.1;  // ... and at least this fraction of the data's top value
	const span = createStableMax({ floor: minSpan });
	let dom: SparkDomain | null = null;
	return {
		update(values, now) {
			let lo = Infinity, hi = -Infinity;
			for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
			if (!Number.isFinite(lo)) return dom ?? { lo: 0, hi: minSpan };
			const S = span.update(Math.max((hi - lo) * pad, hi * relMin, minSpan), now);
			if (!dom || lo < dom.lo || hi > dom.hi || Math.abs(dom.hi - dom.lo - S) > 1e-9) {
				const start = Math.max(0, (lo + hi) / 2 - S / 2);   // RPM is never negative
				dom = { lo: start, hi: start + S };
			}
			return dom;
		},
		reset() { span.reset(); dom = null; },
	};
}

/** SVG polyline points for `values` in a box `width` wide, `height` tall starting at y = `top`. */
export function sparkPoints(values: readonly number[], dom: SparkDomain, width = 200, top = 4, height = 34): string {
	if (values.length < 2) return '';
	const range = dom.hi - dom.lo || 1;
	return values.map((v, i) => {
		const f = Math.min(1, Math.max(0, (v - dom.lo) / range));
		return `${(i / (values.length - 1)) * width},${top + height - f * height}`;
	}).join(' ');
}
