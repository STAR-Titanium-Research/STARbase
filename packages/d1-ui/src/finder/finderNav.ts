import type { FinderGroup, FinderHit } from './finder';

// The finder dialog's pure parts: the listbox's shape and the keyboard's movement through it,
// free of Vue and the DOM so they can be tested on their own.

export interface ListboxItem {
	// DOM id of the option, for aria-activedescendant.
	id: string;
	// Position among all options, across groups: what the arrow keys move.
	index: number;
	hit: FinderHit;
}

export interface ListboxSection {
	group: FinderGroup;
	// DOM id of the group's heading, for aria-labelledby.
	headingId: string;
	items: ListboxItem[];
}

export const optionId = (prefix: string, index: number): string => `${prefix}-opt-${index}`;

// The hits (already in group order, from mergeHits) as sections, each option numbered across the
// whole list. A group's hits are contiguous, so one pass is enough.
export function toSections(hits: FinderHit[], prefix: string): ListboxSection[] {
	const sections: ListboxSection[] = [];
	hits.forEach((hit, index) => {
		let section = sections[sections.length - 1];
		if (!section || section.group !== hit.group) {
			section = { group: hit.group, headingId: `${prefix}-grp-${sections.length}`, items: [] };
			sections.push(section);
		}
		section.items.push({ id: optionId(prefix, index), index, hit });
	});
	return sections;
}

// Arrow-key movement over `count` options, wrapping at both ends. -1 means nothing is active yet:
// down goes to the first, up to the last. An empty list has no active option.
export function moveIndex(current: number, delta: 1 | -1, count: number): number {
	if (count <= 0) return -1;
	if (current < 0 || current >= count) return delta === 1 ? 0 : count - 1;
	return (current + delta + count) % count;
}

// Ctrl K on Windows/Linux, Cmd K on Mac; with Shift or Alt it is someone else's shortcut.
export function isFinderShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
	return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}
