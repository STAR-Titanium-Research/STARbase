// The label/value facts of a record page (the rail and the Details panels): the shape one fact
// takes, which facts are worth drawing, and how a long multi-value fact is cut for the rail.

import { asRecord } from '../format';

export interface Fact {
	label: string;
	value: string | number | null | undefined;
	/** Unit shown after the value in the secondary colour (`mm`, `MPa`). */
	unit?: string;
	/** Monospace, for codes and ids. */
	mono?: boolean;
	/** Makes the value a link to the section with this id on the same page (scrolled to by hand, as "On this page" does). */
	anchor?: string;
	/** Makes the value a link to this app route. */
	to?: string;
	/** The target exists but row-level visibility hides it from the user: drawn as "not visible to you". */
	hidden?: boolean;
	/** A multi-value fact (campaigns, investigators): one entry per item, each optionally a link. */
	list?: Array<{ label: string; to?: string; hidden?: boolean }>;
}

function hasValue(v: Fact['value']): boolean {
	return v !== null && v !== undefined && v !== '';
}

/** The facts worth drawing: empty ones (no value and no list entries) are left out so a page does not
 *  fill up with dashes, unless `hidden`: a parent the user may not see reads "not visible to you",
 *  never blank. Zero is a value. */
export function visibleFacts(facts: Fact[]): Fact[] {
	return facts.filter((f) => f.hidden || hasValue(f.value) || (f.list?.length ?? 0) > 0);
}

/** The first `max` items of a list and how many were left out ("N more"). */
export function capList<T>(items: T[], max = 6): { shown: T[]; more: number } {
	return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/**
 * The Owner fact of a record page: the owning team's name when the record has one (`owner_team_id`, selected as an object), else the
 * owner person's name. A team the reader cannot read arrives as a bare id and reads as nothing, as a hidden person does.
 */
export function ownerName(rec: Record<string, any> | null | undefined): string {
	return asRecord(rec?.owner_team_id)?.name || asRecord(rec?.owner_person_id)?.full_name || '';
}
