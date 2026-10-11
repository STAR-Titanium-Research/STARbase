// The element a page scrolls in. The Data Studio scrolls inside its own content container, not the
// window, so an IntersectionObserver (and a sticky rail) must be measured against that container.

interface Node {
	parentElement: Node | null;
}

/** The nearest ancestor of `start` (not `start` itself) whose `overflow-y` is auto, scroll or overlay;
 *  null when there is none, which means the viewport. `styleOf` is injectable for tests. */
export function findScrollParent<T extends Node>(start: T, styleOf: (el: T) => { overflowY: string }): T | null {
	let el = start.parentElement as T | null;
	while (el) {
		if (/^(auto|scroll|overlay)$/.test(styleOf(el).overflowY)) return el;
		el = el.parentElement as T | null;
	}
	return null;
}
