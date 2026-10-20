// Where keyboard focus goes when the thing that had it is gone (a removed card, a dismissed toast, a closed menu): back to the
// map, so the keyboard user is not left on the page body. A card's wrapper is its tab stop (spec D23).

/** The card named by `id` when it is drawn, else the first card, else the canvas itself. */
export function focusCanvas(canvas: HTMLElement | null | undefined, id?: string): void {
	if (!canvas) return;
	const cards = [...canvas.querySelectorAll<HTMLElement>('.vue-flow__node')];
	const target = (id ? cards.find((c) => c.dataset.id === id) : undefined) ?? cards[0] ?? canvas;
	if (target === canvas && !canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
	target.focus({ preventScroll: true });
}

/** Puts focus back where it was before something opened over the page: on its opener, or, when the opener is gone (a menu that closed with the click that opened this), on `fallback`. */
export function restoreFocus(opener: HTMLElement | null | undefined, fallback?: () => void): void {
	if (opener?.isConnected) opener.focus();
	else fallback?.();
}
