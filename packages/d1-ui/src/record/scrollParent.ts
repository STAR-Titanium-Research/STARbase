// The element a page scrolls in. The Data Studio scrolls inside its own content container, not the
// window, so an IntersectionObserver (and a sticky rail) must be measured against that container.

interface Node {
	parentElement: Node | null;
}

/** The nearest ancestor of `start` (not `start` itself) whose `overflow-y` is auto, scroll or overlay;
 *  null when there is none, which means the viewport. `styleOf` is injectable for tests.
 *  `accept` skips scrollers that are not the one meant: the rail scrolls too (overflow: auto), and
 *  from inside it the first scroller found is the rail, which does not contain the page's sections.
 *  Pass `(el) => el.contains(target)` to find the scroller of `target`. */
export function findScrollParent<T extends Node>(
	start: T,
	styleOf: (el: T) => { overflowY: string },
	accept: (el: T) => boolean = () => true,
): T | null {
	let el = start.parentElement as T | null;
	while (el) {
		if (/^(auto|scroll|overlay)$/.test(styleOf(el).overflowY) && accept(el)) return el;
		el = el.parentElement as T | null;
	}
	return null;
}
