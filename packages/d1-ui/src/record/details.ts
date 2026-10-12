// The "Details" panel of a record page: the record's own values and its process parameters as one
// list of facts. The Operation and Test pages used to draw these as two panels (Overview and
// Parameters); the facts that now sit in the rail are not repeated here.

import type { ParamRow } from '../params';
import { visibleFacts, type Fact } from './facts';

const key = (label: string) => label.trim().toLowerCase();
const text = (v: Fact['value']) => (v === null || v === undefined ? '' : String(v).trim());

/** A process parameter as a fact: the value with its unit after it. */
export function paramFact(p: ParamRow): Fact {
	return { label: p.label, value: p.value, unit: p.unit || undefined };
}

/**
 * The Details panel's count, for its section and its "On this page" entry: null while the parameters
 * load or when their read failed (the count is not known), 0 when everything has answered and there
 * is no fact and no notes (the panel is its empty lid, so the entry is listed dimmed), no count when
 * there are no facts but there are notes (the panel shows only the notes), else the number of facts.
 */
export function detailsCount(factCount: number, hasNotes: boolean, paramsLoading: boolean, paramsError: string | undefined): number | null {
	if (paramsLoading || paramsError) return null;
	if (factCount) return factCount;
	return hasNotes ? null : 0;
}

/**
 * The record's own facts followed by its parameters, as one list of non-empty facts:
 *  - a fact the rail already shows (same label and the same value) is dropped;
 *  - the same label twice with the same value is shown once;
 *  - the same label twice with different values keeps both, the later one as `Label (2)`: the list
 *    keys its rows by label, and two different values under one label would read as a mistake.
 */
export function detailFacts(base: Fact[], params: ParamRow[], rail: Fact[]): Fact[] {
	const inRail = new Set(visibleFacts(rail).map((f) => `${key(f.label)}\u0000${text(f.value)}`));
	const seen = new Map<string, Set<string>>();
	const out: Fact[] = [];
	for (const f of visibleFacts([...base, ...params.map(paramFact)])) {
		const k = key(f.label);
		const v = text(f.value);
		if (inRail.has(`${k}\u0000${v}`)) continue;
		const values = seen.get(k);
		if (!values) {
			seen.set(k, new Set([v]));
			out.push(f);
		} else if (!values.has(v)) {
			values.add(v);
			out.push({ ...f, label: `${f.label} (${values.size})` });
		}
	}
	return out;
}
