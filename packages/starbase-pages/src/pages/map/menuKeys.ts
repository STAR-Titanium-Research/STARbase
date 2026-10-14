// Keys of a small menu (ExportMenu): which item a key moves to, or that it closes the menu. Pure, so it is tested without a DOM.

/** `native`: the key keeps its own job (Tab moves focus on); the menu only closes. */
export type MenuKeyResult = { focus: number } | { close: true; native?: true } | null;

/** `current` is the focused item (-1 for none), `count` the number of items; null for a key the menu does not use. */
export function menuKey(key: string, current: number, count: number): MenuKeyResult {
  if (key === 'Escape') return { close: true };
  if (key === 'Tab') return { close: true, native: true };
  if (count <= 0) return null;
  if (key === 'ArrowDown') return { focus: (current + 1) % count };
  if (key === 'ArrowUp') return { focus: current <= 0 ? count - 1 : current - 1 };
  if (key === 'Home') return { focus: 0 };
  if (key === 'End') return { focus: count - 1 };
  return null;
}

/** Focus moved to `next` (a focusout's relatedTarget): true when that is another element outside the menu (Tab out), which closes it. */
export function focusLeftMenu(next: EventTarget | null, menu: { contains(node: Node): boolean }): boolean {
  return next !== null && !menu.contains(next as Node);
}

/** The element that had focus is gone from the page (a disabled button gives it up): focus is on nothing, or on <body>. */
export function focusLost(active: Element | null, body: Element | null): boolean {
  return active === null || active === body;
}
