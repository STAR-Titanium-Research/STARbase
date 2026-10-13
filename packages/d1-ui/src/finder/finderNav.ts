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

// Whether a modal is on screen, given the host's own selector for one (how a host mounts its
// drawers and dialogs is the host's business: ExplorerView passes Directus's). The finder dialog
// itself must be excluded by the selector, or it would count as the modal that blocks it.
export function isModalOpen(doc: { querySelector(selector: string): unknown }, selector: string): boolean {
	return !!doc.querySelector(selector);
}

// Ctrl K on Windows/Linux, Cmd K on Mac; with Shift or Alt it is someone else's shortcut.
export function isFinderShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
	return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

// A key that types one character into a text box: a single printable character with no Ctrl, Meta or
// Alt. Space is not one here: on a focused button it is "press", and a scanner never needs it first.
export function isTypingKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): boolean {
	return e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey;
}

// A Directus drawer or dialog being open means the user is in the middle of a form: Ctrl K does not
// pull the finder over it. Directus mounts every open drawer and dialog into #dialog-outlet (empty
// otherwise; checked in Directus 11.17), plus any other aria-modal dialog that is not the finder. Not
// `.v-overlay.active` (at narrow widths Directus's own navigation drawer is an "active" absolute overlay
// whenever the nav is shown) and not `.v-dialog .content` (that wrapper is always in the DOM).
const MODAL_SELECTOR = '#dialog-outlet > *, [role="dialog"][aria-modal="true"]:not(.d1-finder)';

// The keydown decision of the finder shortcut: should this press open the finder? It also keeps the
// browser's own Ctrl K (focus the search bar) away on every finder shortcut, whether or not the finder
// then opens, as the Directus frame always did: that is why it calls preventDefault.
export function shouldOpenFinder(
	e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; preventDefault(): void },
	finderOpen: boolean,
	doc: { querySelector(selector: string): unknown },
): boolean {
	if (!isFinderShortcut(e)) return false;
	e.preventDefault();
	return !finderOpen && !isModalOpen(doc, MODAL_SELECTOR);
}
