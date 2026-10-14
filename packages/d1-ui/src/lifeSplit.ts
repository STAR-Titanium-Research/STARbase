// When the life strip's steps are wider than the panel, the strip keeps the start and the latest
// steps and folds the middle ones into one "split" node the reader can expand. Which steps stay is
// decided from the measured width of each step, so the strip fits the panel without scrolling.

import { daySummary, type LifeStep } from './life';

export interface LifeSplit {
	/** Steps shown before the split. */
	head: number;
	/** Steps shown after it (the latest). */
	tail: number;
}

/**
 * The longest start and end that fit `available` pixels with the split node (`splitWidth`) between
 * them, or null when every step fits. The first and last steps always show. The start grows first
 * to reach step `keep` (this sample), then the end and the start take turns, the end first.
 */
export function fitSplit(widths: number[], available: number, splitWidth: number, keep = -1): LifeSplit | null {
	const n = widths.length;
	const total = widths.reduce((a, b) => a + b, 0);
	if (total <= available || n < 3) return null;
	let head = 1;
	let tail = 1;
	let used = widths[0] + widths[n - 1] + splitWidth;
	const room = () => n - head - tail > 1;
	while (head <= keep && room() && used + widths[head] <= available) used += widths[head++];
	let tailOpen = true;
	let headOpen = true;
	while (room() && (tailOpen || headOpen)) {
		if (tailOpen) {
			const w = widths[n - 1 - tail];
			if (used + w <= available) {
				used += w;
				tail++;
			} else tailOpen = false;
		}
		if (headOpen && room()) {
			const w = widths[head];
			if (used + w <= available) {
				used += w;
				head++;
			} else headOpen = false;
		}
	}
	return { head, tail };
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
