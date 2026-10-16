// The move of the Process map's cards to the places a layout gave them: one tween of every card's position, run by requestAnimationFrame.
// It is a JS tween (not a CSS transition) because the wires are drawn from the cards' positions every frame, so they follow the cards
// only when the positions themselves move. New cards start at the card that was expanded and fade in; cards that are gone are not
// part of it (they just vanish). Kept apart from the canvas so it can be tested with a clock and a requestAnimationFrame of its own.
//
// One tween at a time: a layout that arrives while cards are moving starts from where they are now (and as visible as they are now),
// and the layout it replaces is released. Dragging a card takes it out of the tween (`cancel`).

export interface Point {
  x: number;
  y: number;
}

/** One card in one frame: where it is, and how visible (only a card that is fading in carries an opacity). */
export interface TweenFrame {
  id: string;
  /** Where the card was before this frame (Vue Flow's position change wants it). */
  from: Point;
  position: Point;
  opacity?: number;
}

export interface TweenDeps {
  /** Where a card is now (undefined for one that is not drawn). */
  positionOf: (id: string) => Point | undefined;
  /** Draw one frame of cards. */
  apply: (frames: TweenFrame[]) => void;
  now?: () => number;
  /** Missing (a server, a test without one): everything is placed at once. */
  raf?: (callback: (now: number) => void) => unknown;
  cancelRaf?: (handle: unknown) => void;
  /** People who asked for less motion get the places at once. */
  reducedMotion?: () => boolean;
  durationMs?: number;
}

export interface TweenSpec {
  /** Where each card goes. */
  target: Record<string, Point>;
  /** New cards: they start invisible (at `origin`, else at the place they are put) and fade in on the way. */
  fresh?: ReadonlySet<string>;
  /** Where new cards start: the card that was expanded. */
  origin?: Point | null;
  /** Place everything at once (the first layout of a family, which is not shown yet). */
  instant?: boolean;
}

/** About a third of a second: long enough to follow, short enough not to wait for. */
export const TWEEN_MS = 300;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

interface Mover {
  from: Point;
  to: Point;
  /** Null: not fading (stays as it is, no opacity is written). */
  fade: { from: number } | null;
}

export function createMapTween(deps: TweenDeps) {
  const now = deps.now ?? (() => performance.now());
  const duration = deps.durationMs ?? TWEEN_MS;
  let movers = new Map<string, Mover>();
  let started = 0;
  let handle: unknown = null;
  /** How visible each fading card is now: a layout that replaces the tween carries it on. */
  const visible = new Map<string, number>();
  /** Resolves the call of `start` that is running (one at a time) and whoever waits in `whenIdle`. */
  let release: (() => void) | null = null;
  let idle: (() => void)[] = [];

  const at = (id: string): Point => deps.positionOf(id) ?? { x: 0, y: 0 };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  function finish(): void {
    if (handle !== null) deps.cancelRaf?.(handle);
    handle = null;
    movers = new Map();
    const r = release;
    release = null;
    r?.();
    const waiting = idle;
    idle = [];
    waiting.forEach((resolve) => resolve());
  }

  /** Draws the cards at `t` (0..1 of the way, eased); at 1 they are exactly where they go and fully visible. */
  function draw(t: number): void {
    const eased = t >= 1 ? 1 : easeOutCubic(t);
    const frames: TweenFrame[] = [];
    for (const [id, m] of movers) {
      const position = t >= 1 ? { ...m.to } : { x: lerp(m.from.x, m.to.x, eased), y: lerp(m.from.y, m.to.y, eased) };
      const frame: TweenFrame = { id, from: at(id), position };
      if (m.fade) {
        const o = t >= 1 ? 1 : lerp(m.fade.from, 1, eased);
        frame.opacity = o;
        if (o >= 1) visible.delete(id);
        else visible.set(id, o);
      }
      frames.push(frame);
    }
    if (frames.length) deps.apply(frames);
  }

  function tick(time: number): void {
    handle = null;
    if (!movers.size) return;
    const t = Math.min(1, (time - started) / duration);
    draw(t);
    if (t >= 1) finish();
    else handle = deps.raf!(tick);
  }

  /** Cards that were still fading when the tween they were in was replaced or stopped are made fully visible where they are. */
  const settleFading = (ids: Iterable<string>): void => {
    const frames: TweenFrame[] = [];
    for (const id of ids) {
      if (!visible.has(id)) continue;
      visible.delete(id);
      const p = at(id);
      frames.push({ id, from: p, position: p, opacity: 1 });
    }
    if (frames.length) deps.apply(frames);
  };

  /** Moves the cards to `spec.target`; resolves when they are there (or when a newer tween replaced this one, or it was cancelled). */
  function start(spec: TweenSpec): Promise<void> {
    // The tween being replaced: its caller is released, and the cards it was fading that are not in this one are shown in full.
    const gone = [...movers.keys()].filter((id) => !(id in spec.target));
    const previous = release;
    release = null;
    if (handle !== null) deps.cancelRaf?.(handle);
    handle = null;
    movers = new Map();
    previous?.();
    settleFading(gone);

    const next = new Map<string, Mover>();
    for (const [id, to] of Object.entries(spec.target)) {
      const fresh = spec.fresh?.has(id) ?? false;
      const here = deps.positionOf(id);
      const from = fresh ? (spec.origin ?? to) : (here ?? to);
      const carried = visible.get(id);
      const fade = fresh ? { from: 0 } : carried !== undefined ? { from: carried } : null;
      if (!fade && from.x === to.x && from.y === to.y) continue; // nothing to do for this card
      next.set(id, { from: { ...from }, to: { ...to }, fade });
    }
    if (!next.size) {
      finish(); // nobody moves: whoever waits for the cards to settle is released
      return Promise.resolve();
    }

    movers = next;
    const instant = !!spec.instant || (deps.reducedMotion?.() ?? false) || !deps.raf;
    return new Promise<void>((resolve) => {
      release = resolve;
      // Everyone released together when this one ends; a promise per start so a replaced caller does not wait for the new tween.
      if (instant) {
        draw(1);
        finish();
        return;
      }
      started = now();
      draw(0); // the first frame is now: new cards are at their start and invisible before the browser paints
      handle = deps.raf!(tick);
    });
  }

  /** A card is taken out of the tween (the person grabbed it): it stays where it is, fully visible. */
  function cancel(ids: Iterable<string>): void {
    const list = [...ids].filter((id) => movers.has(id));
    for (const id of list) movers.delete(id);
    settleFading(list);
    if (list.length && !movers.size) finish();
  }

  /** Ends the tween where it is (a new focus): nothing is left half-visible. */
  function stop(): void {
    const ids = [...movers.keys()];
    movers = new Map();
    settleFading(ids);
    finish();
  }

  const active = (): boolean => movers.size > 0;
  /** How visible a card is while it fades in (undefined: not fading, fully visible). */
  const opacityOf = (id: string): number | undefined => visible.get(id);
  const whenIdle = (): Promise<void> => (movers.size ? new Promise<void>((resolve) => void idle.push(resolve)) : Promise.resolve());

  return { start, cancel, stop, active, whenIdle, opacityOf };
}

export type MapTween = ReturnType<typeof createMapTween>;
