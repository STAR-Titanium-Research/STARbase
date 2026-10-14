// Keyboard on the Process map (spec D23): Tab walks the cards, the Inside slots and the sockets (the
// browser's own order), Enter selects, `+` expands, `o` opens the record. Pure: no Vue, no DOM globals,
// so the rules are tested without a browser. The page puts one keydown on the canvas and asks here what
// the key means for what has focus.

export type MapKeyAction = 'select' | 'expand' | 'open' | 'none';

/**
 * What a key does to the card or record in focus. Ctrl, Cmd and Alt keep their browser meaning (Ctrl+O,
 * Ctrl++ zoom), nothing happens without a focused record, and Escape is not here: it only clears the
 * hover card, which the page does itself.
 */
export function mapKey(
	e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
	focusedId: string | null,
): { action: MapKeyAction; id?: string } {
	if (!focusedId || e.ctrlKey || e.metaKey || e.altKey) return { action: 'none' };
	switch (e.key) {
		case 'Enter':
			return { action: 'select', id: focusedId };
		case '+':
			return { action: 'expand', id: focusedId };
		case 'o':
		case 'O':
			return { action: 'open', id: focusedId };
		default:
			return { action: 'none' };
	}
}

/** The part of an Element the resolvers use (a plain object stands in for it in the tests). */
export interface ElLike {
	closest?(selector: string): ElLike | null;
	tagName?: string;
	isContentEditable?: boolean;
	dataset?: Record<string, string | undefined>;
}

/** A record inside a card (an Inside slot value) carries its `<collection>:<id>` here. */
export const MAP_ID_ATTR = 'data-map-id';

/**
 * The map element an event happened in: a slot value (`data-map-id`), else the card (Vue Flow's node
 * wrapper, whose `data-id` is the node id). Null for anything else (the controls, the pane).
 */
export function mapElement(target: unknown): { id: string; el: ElLike } | null {
	const el = target as ElLike | null;
	if (!el || typeof el.closest !== 'function') return null;
	const slot = el.closest(`[${MAP_ID_ATTR}]`);
	if (slot?.dataset?.mapId) return { id: slot.dataset.mapId, el: slot };
	const card = el.closest('.vue-flow__node');
	return card?.dataset?.id ? { id: card.dataset.id, el: card } : null;
}

/**
 * What has focus, for the canvas's keydown. `typing`: a field takes the key, the map ignores it.
 * `id`: the card or record in focus; null on a socket (focus there only lists its wires in the rail) and
 * on the controls. `control`: a button or link, which keeps Enter for itself.
 */
export function keyTarget(target: unknown): { id: string | null; typing: boolean; control: boolean } {
	const el = target as ElLike | null;
	if (!el || typeof el.closest !== 'function') return { id: null, typing: false, control: false };
	const tag = el.tagName?.toLowerCase();
	const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
	const control = !!el.closest('button, a, [role="button"]');
	const socket = !!el.closest('.vue-flow__handle');
	return { id: socket ? null : (mapElement(el)?.id ?? null), typing, control };
}

/**
 * Did focus arrive by keyboard? A mouse click on a socket or card also focuses it, and that must not
 * act like keyboard navigation (no hover stack entry, no pan). `:focus-visible` tells the two apart; a
 * browser or stand-in that cannot answer counts as keyboard (the safe side: the page just reveals).
 */
export function isKeyboardFocus(target: unknown): boolean {
	try {
		return (target as { matches(sel: string): boolean }).matches(':focus-visible');
	} catch {
		return true;
	}
}

/** The card (Vue Flow node wrapper) holding `target`, whatever inside it is focused: a slot's owning card, not the slot's own key. */
export function cardOf(target: unknown): { id: string; el: ElLike } | null {
	const el = target as ElLike | null;
	if (!el || typeof el.closest !== 'function') return null;
	const card = el.closest('.vue-flow__node');
	return card?.dataset?.id ? { id: card.dataset.id, el: card } : null;
}
