// True when some text is selected on the page. A click that ends a drag-select (the user marking text
// inside a card) must not also open the card: the click handlers of a whole-card link check this first.
export function hasTextSelection(): boolean {
	return typeof window !== 'undefined' && !!window.getSelection?.()?.toString();
}
