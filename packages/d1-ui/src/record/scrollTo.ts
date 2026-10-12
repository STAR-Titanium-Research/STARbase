// A click on an in-page link ("On this page", a rail count that points at a panel): scroll the
// section into view by hand. The Data Studio scrolls inside its own container and the router has no
// scroll behaviour for a hash, so a plain `#id` link would do nothing there.

/** Scrolls the element with this id to the top of its scroller and puts `#id` in the address bar
 *  without a navigation. Returns true when the click was handled (the caller's `preventDefault`
 *  has run); a modified click (new tab, new window) or a missing element is left to the browser. */
export function scrollToSection(id: string, event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'preventDefault'>): boolean {
	if (typeof document === 'undefined') return false;
	if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
	const el = document.getElementById(id);
	if (!el) return false;
	event.preventDefault();
	el.scrollIntoView({ block: 'start' });
	// The hash is for sharing the place; replaceState keeps the router state and starts no navigation.
	if (typeof history !== 'undefined') history.replaceState(history.state, '', `#${id}`);
	return true;
}
