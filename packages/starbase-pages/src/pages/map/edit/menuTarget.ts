// Where the Add menu opens and what it is for (spec E8). Shared by the controllers that open it (a socket's click or drop, Shift+A, a
// right-click on the canvas) and by the menu itself.

import type { SocketRef } from './socketRefs';

export interface MenuTarget {
	/** The socket the menu is for; null for the unconnected menu (Shift+A, right-click on empty canvas, the lid's Add). */
	sock: SocketRef | null;
	/** Where the menu opens, in client pixels. */
	at: { x: number; y: number };
	/** Where a card the menu adds is placed (the map's own coordinates), when the person pointed at empty canvas. */
	flow?: { x: number; y: number };
	/** The card the socket is on, so the layout puts what is added beside it. */
	anchor?: string;
}
