import { describe, expect, it } from 'vitest';
import { createMapTween, type TweenFrame } from './useMapTween';

type P = { x: number; y: number };

/** A clock and a requestAnimationFrame the test steps by hand; the canvas's node positions are a plain object. */
function setup(opts: { reduced?: boolean; noRaf?: boolean } = {}) {
  let t = 0;
  let queue: ((now: number) => void)[] = [];
  const nodes: Record<string, P> = {};
  const opacity: Record<string, number> = {};
  const frames: TweenFrame[][] = [];
  const tween = createMapTween({
    now: () => t,
    raf: opts.noRaf ? undefined : (cb) => void queue.push(cb),
    reducedMotion: () => !!opts.reduced,
    durationMs: 300,
    positionOf: (id) => nodes[id],
    apply: (list) => {
      frames.push(list);
      for (const f of list) {
        nodes[f.id] = { ...f.position };
        opacity[f.id] = f.opacity as number;
      }
    },
  });
  /** Advance the clock by `ms` and run the frame that was waiting. */
  const step = (ms: number) => {
    t += ms;
    const run = queue;
    queue = [];
    run.forEach((cb) => cb(t));
  };
  return { tween, nodes, opacity, frames, step, waiting: () => queue.length };
}

describe('useMapTween', () => {
  it('moves every card from where it is to where it goes, and ends exactly there', async () => {
    const s = setup();
    s.nodes.a = { x: 0, y: 0 };
    s.nodes.b = { x: 100, y: 100 };
    let done = false;
    void s.tween.start({ target: { a: { x: 200, y: 0 }, b: { x: 100, y: 100 } } }).then(() => (done = true));
    s.step(150);
    expect(s.nodes.a.x).toBeGreaterThan(0);
    expect(s.nodes.a.x).toBeLessThan(200);
    expect(s.nodes.b).toEqual({ x: 100, y: 100 });
    await Promise.resolve();
    expect(done).toBe(false);
    s.step(150);
    await Promise.resolve();
    expect(s.nodes.a).toEqual({ x: 200, y: 0 });
    expect(done).toBe(true);
    expect(s.waiting()).toBe(0);
  });

  it('eases out: more than half the way at half the time', () => {
    const s = setup();
    s.nodes.a = { x: 0, y: 0 };
    void s.tween.start({ target: { a: { x: 100, y: 0 } } });
    s.step(150);
    expect(s.nodes.a.x).toBeCloseTo(87.5, 5); // 1 - (1 - 0.5)^3
  });

  it('new cards start at the anchor with no opacity and fade in as they arrive', async () => {
    const s = setup();
    s.nodes.a = { x: 50, y: 50 };
    s.nodes.n = { x: 0, y: 0 }; // where the canvas put it when it was made
    void s.tween.start({ target: { a: { x: 50, y: 50 }, n: { x: 400, y: 200 } }, fresh: new Set(['n']), origin: { x: 50, y: 50 } });
    expect(s.nodes.n).toEqual({ x: 50, y: 50 }); // at the anchor from the first frame
    expect(s.opacity.n).toBe(0);
    s.step(150);
    expect(s.opacity.n).toBeGreaterThan(0);
    expect(s.opacity.n).toBeLessThan(1);
    expect(s.nodes.n.x).toBeGreaterThan(50);
    s.step(150);
    await Promise.resolve();
    expect(s.opacity.n).toBe(1);
    expect(s.nodes.n).toEqual({ x: 400, y: 200 });
    expect(s.opacity.a).toBeUndefined(); // a card that was already there is never touched by the fade
  });

  it('a new card with no anchor appears where it goes, fading in', () => {
    const s = setup();
    s.nodes.n = { x: 0, y: 0 };
    void s.tween.start({ target: { n: { x: 400, y: 200 } }, fresh: new Set(['n']) });
    expect(s.nodes.n).toEqual({ x: 400, y: 200 });
    expect(s.opacity.n).toBe(0);
  });

  it('places everything at once, fully visible, for people who asked for less motion', async () => {
    const s = setup({ reduced: true });
    s.nodes.a = { x: 0, y: 0 };
    s.nodes.n = { x: 0, y: 0 };
    await s.tween.start({ target: { a: { x: 200, y: 0 }, n: { x: 5, y: 5 } }, fresh: new Set(['n']), origin: { x: 0, y: 0 } });
    expect(s.nodes.a).toEqual({ x: 200, y: 0 });
    expect(s.nodes.n).toEqual({ x: 5, y: 5 });
    expect(s.opacity.n).toBe(1);
    expect(s.waiting()).toBe(0);
  });

  it('places everything at once where there is no requestAnimationFrame', async () => {
    const s = setup({ noRaf: true });
    s.nodes.a = { x: 0, y: 0 };
    await s.tween.start({ target: { a: { x: 200, y: 0 } } });
    expect(s.nodes.a).toEqual({ x: 200, y: 0 });
  });

  it('a new layout mid-way starts from where the cards are now (and how visible they are), not from where the first began', async () => {
    const s = setup();
    s.nodes.a = { x: 0, y: 0 };
    s.nodes.n = { x: 0, y: 0 };
    let first = false;
    void s.tween.start({ target: { a: { x: 100, y: 0 }, n: { x: 100, y: 0 } }, fresh: new Set(['n']), origin: { x: 0, y: 0 } }).then(() => (first = true));
    s.step(150);
    const mid = s.nodes.a.x;
    const midOpacity = s.opacity.n;
    expect(mid).toBeGreaterThan(0);
    s.frames.length = 0;
    let second = false;
    void s.tween.start({ target: { a: { x: 0, y: 0 }, n: { x: 100, y: 0 } } }).then(() => (second = true));
    await Promise.resolve();
    expect(first).toBe(true); // the first was replaced: its caller is released
    expect(second).toBe(false);
    // The first frame of the second tween is where the cards were: no jump back to the start.
    const f0 = s.frames[0].find((f) => f.id === 'a')!;
    expect(f0.position.x).toBeCloseTo(mid, 5);
    expect(s.opacity.n).toBeCloseTo(midOpacity, 5);
    s.step(150);
    expect(s.nodes.a.x).toBeLessThan(mid);
    expect(s.nodes.a.x).toBeGreaterThan(0);
    s.step(150);
    await Promise.resolve();
    expect(s.nodes.a).toEqual({ x: 0, y: 0 });
    expect(s.opacity.n).toBe(1);
    expect(second).toBe(true);
  });

  it('whenIdle resolves only once the cards have arrived', async () => {
    const s = setup();
    s.nodes.a = { x: 0, y: 0 };
    expect(s.tween.active()).toBe(false);
    void s.tween.start({ target: { a: { x: 100, y: 0 } } });
    expect(s.tween.active()).toBe(true);
    let idle = false;
    void s.tween.whenIdle().then(() => (idle = true));
    s.step(299);
    await Promise.resolve();
    expect(idle).toBe(false);
    s.step(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toBe(true);
    expect(s.tween.active()).toBe(false);
  });

  it('whenIdle is already resolved when nothing moves', async () => {
    const s = setup();
    await s.tween.whenIdle();
  });

  it('cancelling a card (it is being dragged) leaves it where it is, visible, and the others carry on', async () => {
    const s = setup();
    s.nodes.a = { x: 0, y: 0 };
    s.nodes.b = { x: 0, y: 0 };
    void s.tween.start({ target: { a: { x: 100, y: 0 }, b: { x: 100, y: 0 } }, fresh: new Set(['b']), origin: { x: 0, y: 0 } });
    s.step(100);
    const held = { ...s.nodes.b };
    s.tween.cancel(['b']);
    expect(s.opacity.b).toBe(1);
    s.step(100);
    expect(s.nodes.b).toEqual(held);
    expect(s.nodes.a.x).toBeGreaterThan(s.nodes.b.x);
    s.step(100);
    await Promise.resolve();
    expect(s.nodes.a).toEqual({ x: 100, y: 0 });
    expect(s.nodes.b).toEqual(held);
    expect(s.tween.active()).toBe(false);
  });

  it('cancelling the last moving card ends the tween and releases whoever waits', async () => {
    const s = setup();
    s.nodes.a = { x: 0, y: 0 };
    let done = false;
    void s.tween.start({ target: { a: { x: 100, y: 0 } } }).then(() => (done = true));
    s.tween.cancel(['a']);
    await Promise.resolve();
    expect(done).toBe(true);
    expect(s.tween.active()).toBe(false);
  });

  it('stop() releases everything at once and leaves the cards visible where they are', async () => {
    const s = setup();
    s.nodes.n = { x: 0, y: 0 };
    let done = false;
    void s.tween.start({ target: { n: { x: 100, y: 0 } }, fresh: new Set(['n']), origin: { x: 0, y: 0 } }).then(() => (done = true));
    s.step(100);
    s.tween.stop();
    await Promise.resolve();
    expect(done).toBe(true);
    expect(s.opacity.n).toBe(1);
  });
});
