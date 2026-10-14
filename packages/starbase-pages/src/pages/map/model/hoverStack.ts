// What the pointer is over on the Process map, as a stack (spec D16, D17). mouseenter / mouseleave nest
// the way the elements do: entering a slot inside a card pushes the slot on top of the card, leaving
// the slot pops it, and the card is what is hovered again. So a slot's `hover(null)` falls back to its
// card without the page having to ask the DOM. Pure: no Vue.

export interface Hovered {
  id: string;
  el?: HTMLElement;
}

/** Deep enough for a wire over a slot in a card; a stuck entry (a node removed under the pointer) cannot grow it. */
const MAX_DEPTH = 6;

export function createHoverStack() {
  let stack: Hovered[] = [];
  return {
    /** `hover(id, el)` enters; `hover(null)` leaves the innermost thing entered. Returns what is hovered now. */
    hover(id: string | null, el?: HTMLElement): Hovered | null {
      if (id === null) stack.pop();
      else stack = [...stack, { id, el }].slice(-MAX_DEPTH);
      return stack[stack.length - 1] ?? null;
    },
    /** Forget everything: the graph was rebuilt (a removed element never fires mouseleave) or the pointer left the map. */
    clear(): null {
      stack = [];
      return null;
    },
  };
}
