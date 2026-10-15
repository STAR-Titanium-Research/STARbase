import { describe, expect, it } from 'vitest';
import { createHoverStack } from './hoverStack';

const el = (n: string) => ({ n }) as unknown as HTMLElement;

describe('createHoverStack', () => {
  it('entering a card, then a slot in it, then leaving the slot hovers the card again', () => {
    const h = createHoverStack();
    expect(h.hover('op:cut', el('card'))).toMatchObject({ id: 'op:cut' });
    expect(h.hover('equipment:e1', el('slot'))).toMatchObject({ id: 'equipment:e1' });
    expect(h.hover(null)).toMatchObject({ id: 'op:cut', el: el('card') });
    expect(h.hover(null)).toBeNull();
  });

  it('leaving with nothing entered stays empty', () => {
    expect(createHoverStack().hover(null)).toBeNull();
  });

  it('a wire entered after leaving a card does not keep the card', () => {
    const h = createHoverStack();
    h.hover('s:a');
    h.hover(null);
    expect(h.hover('w1>w2')).toMatchObject({ id: 'w1>w2' });
    expect(h.hover(null)).toBeNull();
  });

  it('clear forgets everything', () => {
    const h = createHoverStack();
    h.hover('s:a');
    h.hover('equipment:e1');
    expect(h.clear()).toBeNull();
    expect(h.hover(null)).toBeNull();
  });

  it('a stuck entry cannot grow the stack without bound', () => {
    const h = createHoverStack();
    for (let i = 0; i < 50; i++) h.hover(`n${i}`);
    let left = 0;
    while (h.hover(null)) left++;
    expect(left).toBeLessThan(10);
  });
});
