import { describe, expect, it } from 'vitest';
import { menuKey } from './menuKeys';

describe('menuKey', () => {
  it('moves down and wraps', () => {
    expect(menuKey('ArrowDown', 0, 2)).toEqual({ focus: 1 });
    expect(menuKey('ArrowDown', 1, 2)).toEqual({ focus: 0 });
    expect(menuKey('ArrowDown', -1, 2)).toEqual({ focus: 0 });
  });
  it('moves up and wraps', () => {
    expect(menuKey('ArrowUp', 1, 2)).toEqual({ focus: 0 });
    expect(menuKey('ArrowUp', 0, 2)).toEqual({ focus: 1 });
    expect(menuKey('ArrowUp', -1, 2)).toEqual({ focus: 1 });
  });
  it('jumps to the ends', () => {
    expect(menuKey('Home', 1, 3)).toEqual({ focus: 0 });
    expect(menuKey('End', 0, 3)).toEqual({ focus: 2 });
  });
  it('closes on Escape, even with no items', () => {
    expect(menuKey('Escape', 0, 2)).toEqual({ close: true });
    expect(menuKey('Escape', -1, 0)).toEqual({ close: true });
  });
  it('ignores other keys and an empty menu', () => {
    expect(menuKey('a', 0, 2)).toBeNull();
    expect(menuKey('ArrowDown', 0, 0)).toBeNull();
  });
});
