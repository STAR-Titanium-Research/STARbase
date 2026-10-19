// Where the add search opens and what it is for (redesign R1, R2). Shared by the controllers that open it (a socket's click or drop, Shift+A,
// Ctrl/⌘+K, "Insert before / after" on a selected card, the lid's Add) and by the search itself.

import type { SocketRef } from './socketRefs';

/** "Insert before / after" the selected card: the search lists the operations that can go there (or, for a done sample, the one step it may take). */
export interface InsertTarget {
	where: 'before' | 'after';
	/** The drawn card the insert is for. */
	nodeId: string;
	/** What the card is called, for the title: "Insert before S-0412-A". */
	what: string;
	/** A done sample, "before": its parentage is never changed, so the only thing offered is "Add an earlier step" (R3). */
	earlier?: boolean;
}

export interface MenuTarget {
	/** The socket the menu is for; null for the unconnected search (Shift+A, Ctrl/⌘+K, right-click on empty canvas, the lid's Add). */
	sock: SocketRef | null;
	/** Where the search opens, in client pixels. */
	at: { x: number; y: number };
	/** Where a card the search adds is placed (the map's own coordinates), when the person pointed at empty canvas. */
	flow?: { x: number; y: number };
	/** The card the socket is on, so the layout puts what is added beside it. */
	anchor?: string;
	/** An insert before or after a selected card (no socket). */
	insert?: InsertTarget;
}
