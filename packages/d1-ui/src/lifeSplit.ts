// When the life strip's steps are wider than the panel, the strip keeps the start, this sample and
// the latest steps and folds the others into "split" nodes the reader can expand. Which steps stay is
// decided from the measured width of each step, so the strip fits the panel without scrolling.

import { daySummary, type LifeStep } from './life';

export interface LifeSplit {
	/** The folded runs of steps, `[from, to)`, in order: one split node each. */
	hidden: [number, number][];
}

/**
 * Which steps fold so the rest fit `available` pixels, each folded run drawn as one split node
 * (`splitWidth`); null when every step fits. The first and last steps and step `keep` (this
 * sample) always show. The start grows to reach `keep`; then the end and the steps after `keep`
 * take turns, the end first, and one run folds. When the start cannot reach `keep` (a long line of
 * parents), the oldest steps after the first fold instead: the end, the steps after `keep` and the
 * nearest steps before it take turns, and two runs fold.
 */
export function fitSplit(widths: number[], available: number, splitWidth: number, keep = -1): LifeSplit | null {
	const n = widths.length;
	if (n < 3 || widths.reduce((a, b) => a + b, 0) <= available) return null;
	let shown: boolean[] = [];
	const reset = () => {
		shown = widths.map((_, i) => i === 0 || i === n - 1 || i === keep);
	};
	const cost = () => {
		let c = 0;
		for (let i = 0; i < n; i++) {
			if (shown[i]) c += widths[i];
			else if (i === 0 || shown[i - 1]) c += splitWidth;
		}
		return c;
	};
	const show = (i: number): boolean => {
		shown[i] = true;
		if (cost() <= available) return true;
		shown[i] = false;
		return false;
	};
	// Each grower reveals the next hidden step in its direction, until one does not fit.
	const grow = (growers: { at: number; step: number }[]) => {
		const open = growers.map(() => true);
		while (open.some(Boolean)) {
			growers.forEach((g, k) => {
				if (!open[k]) return;
				while (g.at >= 0 && g.at < n && shown[g.at]) g.at += g.step;
				if (g.at < 0 || g.at >= n || !show(g.at)) open[k] = false;
			});
		}
	};

	reset();
	let h = 1;
	while (h < keep && show(h)) h++;
	if (h >= keep) grow([{ at: n - 2, step: -1 }, { at: h, step: 1 }]);
	else {
		reset();
		grow([{ at: n - 2, step: -1 }, { at: keep + 1, step: 1 }, { at: keep - 1, step: -1 }]);
	}

	const hidden: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		if (shown[i]) continue;
		const from = i;
		while (i < n && !shown[i]) i++;
		hidden.push([from, i]);
	}
	return hidden.length ? { hidden } : null;
}

const plural = (n: number, one: string, many: string): string => (n ? `${n} ${n === 1 ? one : many}` : '');

/** The split node's text: how many steps it hides, and what they are ("12 operations · 3 tests", "2 samples", the dates). */
export function splitSummary(hidden: LifeStep[]): { label: string; lines: string[] } {
	let operations = 0;
	let tests = 0;
	let samples = 0;
	let lots = 0;
	const dated: string[] = [];
	for (const s of hidden) {
		if (s.type === 'day') {
			operations += s.operations;
			tests += s.tests;
			if (s.items.some((i) => i.date)) dated.push(s.dayText);
		} else if (s.item.kind === 'ancestor' || s.item.kind === 'descendant') samples++;
		else if (s.item.kind === 'stock') lots++;
	}
	const range = dated.length === 0 ? '' : dated.length === 1 ? dated[0] : `${dated[0]} – ${dated[dated.length - 1]}`;
	const lines = [
		daySummary({ operations, tests }),
		[plural(samples, 'sample', 'samples'), plural(lots, 'stock lot', 'stock lots')].filter(Boolean).join(' · '),
		range,
	].filter(Boolean);
	return { label: `${hidden.length} more ${hidden.length === 1 ? 'step' : 'steps'}`, lines };
}
