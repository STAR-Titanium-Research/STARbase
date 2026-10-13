// Where a rail hover menu sits (explorer-sidebar-b2 spec, decision 7): just right of the rail, level
// with its icon, at most 480px tall (and never taller than the window), kept inside the window.
// Pure, so it can be tested without a DOM.
export const MENU_WIDTH = 224;
export const MENU_MAX_HEIGHT = 480;
export const MENU_MARGIN = 8;

export interface MenuPlacement {
	left: number;
	top: number;
	maxHeight: number;
}

export function placeMenu(o: {
	// The icon's top and the rail's right edge, in viewport pixels.
	anchorTop: number;
	edge: number;
	// The menu's natural height (0 before it has been measured).
	menuHeight: number;
	viewportWidth: number;
	viewportHeight: number;
}): MenuPlacement {
	const maxHeight = Math.max(0, Math.min(MENU_MAX_HEIGHT, o.viewportHeight - 2 * MENU_MARGIN));
	const height = Math.min(o.menuHeight, maxHeight);
	const lowest = Math.max(MENU_MARGIN, o.viewportHeight - height - MENU_MARGIN);
	return {
		left: Math.max(0, Math.min(o.edge, o.viewportWidth - MENU_WIDTH)),
		top: Math.max(MENU_MARGIN, Math.min(o.anchorTop, lowest)),
		maxHeight,
	};
}

// What a pointer event or a click does to a hover menu, by input type. A mouse opens it by hovering
// (so its click keeps it open); a finger has no hover, so a tap toggles; the keyboard's Enter and
// Space (a click with no pointer type) toggle too.
export function clickAction(pointerType: string, isOpen: boolean): 'open' | 'close' | 'keep' {
	if (pointerType === 'mouse') return isOpen ? 'keep' : 'open';
	return isOpen ? 'close' : 'open';
}
