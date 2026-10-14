// Keys of a small menu (ExportMenu): which item a key moves to, or that it closes the menu. Pure, so it is tested without a DOM.

export type MenuKeyResult = { focus: number } | { close: true } | null;

/** `current` is the focused item (-1 for none), `count` the number of items; null for a key the menu does not use. */
export function menuKey(key: string, current: number, count: number): MenuKeyResult {
  if (key === 'Escape') return { close: true };
  if (count <= 0) return null;
  if (key === 'ArrowDown') return { focus: (current + 1) % count };
  if (key === 'ArrowUp') return { focus: current <= 0 ? count - 1 : current - 1 };
  if (key === 'Home') return { focus: 0 };
  if (key === 'End') return { focus: count - 1 };
  return null;
}
