// The fly-in of picked samples (spec E7): each card flies from the rectangle its row had in the picker to the place it lands on the
// canvas (FLIP: First, Last, Invert, Play), one after another 40 ms apart. A row that was not on screen when the picks were confirmed
// has no rectangle, so its card only fades in. People who asked for less motion get a 150 ms fade for all of them. Undo plays the
// same thing backwards (a ghost of each card flies back to its row and fades), redo forwards again.
//
// The maths of rectangles and keyframes is pure and tested; `playFly` is the thin part that talks to the page.

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export const STAGGER_MS = 40;
export const FLY_MS = 420;
export const FADE_MS = 150;
/** After this many cards the stagger stops growing: a pick of fifty must not take two seconds to finish. */
export const STAGGER_CAP = 20;
export const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** The card never starts smaller than this part of its size, or larger than it is: a row is wide and thin, a card is not. */
export const MIN_SCALE = 0.25;

/** A DOMRect (or anything with its four numbers) as a Rect. */
export const rectOf = (r: { left: number; top: number; width: number; height: number }): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

const centre = (r: Rect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/**
 * The transform that puts a card that is at `last` where `first` is: centres on each other, one scale for both axes (so the card is
 * not stretched into the shape of a row) that fits the card into the row's width, within MIN_SCALE and 1. `zoom` is the canvas's, for a
 * card that is drawn inside it (a ghost is not: it is fixed on the page).
 */
export function invert(first: Rect, last: Rect, zoom = 1): { dx: number; dy: number; scale: number } {
	const a = centre(first);
	const b = centre(last);
	const raw = last.width > 0 ? first.width / last.width : 1;
	// A card on the canvas sits inside the zoomed viewport: its transform is in the viewport's units, the rectangles are in screen
	// pixels. The scale is a ratio, the same in both.
	const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
	return { dx: (a.x - b.x) / z, dy: (a.y - b.y) / z, scale: Math.min(1, Math.max(MIN_SCALE, raw)) };
}

export const transformOf = (t: { dx: number; dy: number; scale: number }): string => `translate(${round(t.dx)}px, ${round(t.dy)}px) scale(${round(t.scale)})`;
const round = (n: number) => Math.round(n * 100) / 100;

/** The keyframes of one card landing: from its row (or just transparent) to where it is. `reverse` flies it back. */
export function keyframes(first: Rect | null, last: Rect, o: { reduced: boolean; reverse?: boolean; zoom?: number }): Keyframe[] {
	const there: Keyframe = { transform: 'none', opacity: 1 };
	let from: Keyframe;
	if (o.reduced || !first) from = { transform: 'none', opacity: 0 };
	else from = { transform: transformOf(invert(first, last, o.zoom)), opacity: 0.35 };
	// `transform-origin` is the card's centre: the transform above is between centres.
	return o.reverse ? [there, from] : [from, there];
}

/** When the card starts and how long it takes: staggered by position in the pick, or all together in a short fade. */
export function timing(index: number, o: { reduced: boolean }): { delay: number; duration: number } {
	if (o.reduced) return { delay: 0, duration: FADE_MS };
	return { delay: Math.min(index, STAGGER_CAP) * STAGGER_MS, duration: FLY_MS };
}

export interface FlyCard {
	id: string;
	/** Where its row was in the picker; null when the row was not on screen. */
	first: Rect | null;
	/** Where the card is (or was) on the canvas, on screen. */
	last: Rect;
}

export interface FlyStep {
	id: string;
	keyframes: Keyframe[];
	delay: number;
	duration: number;
	last: Rect;
}

/** One step per card, in the order they were picked. */
export function planFly(cards: readonly FlyCard[], o: { reduced: boolean; reverse?: boolean; zoom?: number }): FlyStep[] {
	return cards.map((c, i) => ({ id: c.id, keyframes: keyframes(c.first, c.last, o), ...timing(i, o), last: c.last }));
}

/** Pairs what the picker measured with where the cards landed; a card with no measured place on the canvas is left out (nothing to fly). */
export function cardsOf(picked: readonly { id: string; rect: Rect | null }[], landed: ReadonlyMap<string, Rect | null>): FlyCard[] {
	const out: FlyCard[] = [];
	for (const p of picked) {
		const last = landed.get(p.id);
		if (last) out.push({ id: p.id, first: p.rect, last });
	}
	return out;
}

/** The total time a fly takes to finish, for whoever waits on it. */
export const totalMs = (steps: readonly FlyStep[]): number => steps.reduce((m, s) => Math.max(m, s.delay + s.duration), 0);

// ---- history of flies, for undo and redo ---------------------------------------------------------------

export interface FlyEntry {
	/** The samples the pick added, in order. */
	ids: string[];
	/** Where each row was (null: not on screen). */
	rects: (Rect | null)[];
}

/**
 * The entry an undo or redo of one step is the fly of: the one whose samples are exactly what changed. `change` is the ids that
 * disappeared (undo) or came back (redo); null when it is some other change.
 */
export function entryFor(log: readonly FlyEntry[], change: readonly string[]): FlyEntry | null {
	if (!change.length) return null;
	const set = new Set(change);
	return log.find((e) => e.ids.length === set.size && e.ids.every((id) => set.has(id))) ?? null;
}

/** The ids of existing samples in `a` that `b` does not have. */
export function samplesLost(a: { items: readonly { kind: string; existing?: { id: string } }[] }, b: { items: readonly { kind: string; existing?: { id: string } }[] }): string[] {
	const has = new Set(b.items.flatMap((i) => (i.kind === 'sample' && i.existing ? [i.existing.id] : [])));
	return a.items.flatMap((i) => (i.kind === 'sample' && i.existing && !has.has(i.existing.id) ? [i.existing.id] : []));
}

// ---- playing -------------------------------------------------------------------------------------------

export interface FlyTarget {
	/** The element to animate (a card), or null when it is not drawn. */
	element(id: string): Pick<HTMLElement, 'animate'> | null;
	/** A ghost of a card that is gone (reverse): an element at `rect`, removed when the animation ends. */
	ghost(id: string, rect: Rect): Pick<HTMLElement, 'animate'> & { remove(): void };
}

/** Plays the steps. Forward steps animate the real cards; reverse steps animate ghosts at the cards' old places. Resolves when all end. */
export async function playFly(steps: readonly FlyStep[], target: FlyTarget, o: { reverse?: boolean } = {}): Promise<void> {
	const running: Promise<unknown>[] = [];
	for (const s of steps) {
		const ghost = o.reverse ? target.ghost(s.id, s.last) : null;
		const el = ghost ?? target.element(s.id);
		if (!el) continue;
		const anim = el.animate(s.keyframes, { duration: s.duration, delay: s.delay, easing: EASING, fill: o.reverse ? 'forwards' : 'backwards' });
		running.push(
			(anim.finished ?? Promise.resolve()).catch(() => undefined).then(() => {
				ghost?.remove();
			}),
		);
	}
	await Promise.all(running);
}
