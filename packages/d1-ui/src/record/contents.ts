// The "On this page" list: the page's sections in page order with their counts, which are empty
// and which is in view. Pure; PageContents feeds it the ids its observer reports and draws the result.

export interface ContentsEntry {
	/** The id of the section element on the page (`Section`'s `id`). */
	id: string;
	title: string;
	/** Rows in the section; null when the section has no count (a Details panel). */
	count: number | null;
}

export interface ContentsItem extends ContentsEntry {
	/** A count of zero: listed dimmed. */
	empty: boolean;
	/** The first entry, in page order, whose section is in view. None in view: no entry is current. */
	current: boolean;
}

export function contentsModel(entries: ContentsEntry[], visibleIds: Set<string>): ContentsItem[] {
	const current = entries.find((e) => visibleIds.has(e.id))?.id ?? null;
	return entries.map((e) => ({ ...e, empty: e.count === 0, current: e.id === current }));
}
