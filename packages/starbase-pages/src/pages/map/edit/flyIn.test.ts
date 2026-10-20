import { describe, expect, it, vi } from 'vitest';
import { FADE_MS, FLY_MS, MIN_SCALE, STAGGER_CAP, STAGGER_MS, cardsOf, entryFor, invert, keyframes, planFly, playFly, rectOf, samplesLost, timing, totalMs, transformOf, type FlyEntry, type FlyTarget, type Rect } from './flyIn';

const rect = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

describe('the move from a row to a card', () => {
	it('puts the centre of the card on the centre of the row', () => {
		const row = rect(100, 400, 600, 40); // centre 400, 420
		const card = rect(800, 100, 220, 100); // centre 910, 150
		const t = invert(row, card);
		expect(t.dx).toBe(-510);
		expect(t.dy).toBe(270);
	});

	it('scales to the row\'s width, one scale for both axes, never above 1 and never below the minimum', () => {
		expect(invert(rect(0, 0, 110, 40), rect(0, 0, 220, 100)).scale).toBe(0.5);
		expect(invert(rect(0, 0, 600, 40), rect(0, 0, 220, 100)).scale).toBe(1);
		expect(invert(rect(0, 0, 10, 40), rect(0, 0, 220, 100)).scale).toBe(MIN_SCALE);
	});

	it('divides the distance by the canvas zoom: the card moves in the zoomed viewport\'s units (a ratio is the same in both)', () => {
		const row = rect(100, 400, 600, 40);
		const card = rect(800, 100, 110, 50); // on screen at zoom 0.5 (it is 220 x 100 in the viewport)
		const half = invert(row, card, 0.5);
		const one = invert(row, card);
		expect(half.dx).toBeCloseTo(one.dx * 2);
		expect(half.dy).toBeCloseTo(one.dy * 2);
		expect(half.scale).toBe(one.scale);
		expect(invert(row, card, 0).dx).toBe(one.dx); // a bad zoom counts as 1
	});

	it('carries the zoom into the keyframes of a card on the canvas', () => {
		const row = rect(100, 400, 600, 40);
		const card = rect(800, 100, 220, 100);
		const [from] = keyframes(row, card, { reduced: false, zoom: 2 });
		expect(from.transform).toBe(`translate(${-510 / 2}px, ${270 / 2}px) scale(1)`);
	});

	it('copes with a card that has no width yet', () => {
		expect(invert(rect(0, 0, 100, 40), rect(0, 0, 0, 0)).scale).toBe(1);
	});

	it('is written as a CSS transform, rounded', () => {
		expect(transformOf({ dx: -510.123, dy: 270, scale: 0.5 })).toBe('translate(-510.12px, 270px) scale(0.5)');
	});

	it('is read from a DOMRect', () => {
		expect(rectOf({ left: 1, top: 2, width: 3, height: 4, ...{ right: 4, bottom: 6, x: 1, y: 2 } } as DOMRect)).toEqual(rect(1, 2, 3, 4));
	});
});

describe('the keyframes of one card', () => {
	const row = rect(100, 400, 110, 40);
	const card = rect(800, 100, 220, 100);

	it('fly from the row to where the card is, and fade in', () => {
		const [from, to] = keyframes(row, card, { reduced: false });
		expect(from).toMatchObject({ opacity: 0.35 });
		expect(String(from.transform)).toMatch(/^translate\(-?\d/);
		expect(to).toEqual({ transform: 'none', opacity: 1 });
	});

	it('only fade in when the row was not on screen', () => {
		expect(keyframes(null, card, { reduced: false })).toEqual([{ transform: 'none', opacity: 0 }, { transform: 'none', opacity: 1 }]);
	});

	it('only fade in for people who asked for less motion', () => {
		expect(keyframes(row, card, { reduced: true })).toEqual([{ transform: 'none', opacity: 0 }, { transform: 'none', opacity: 1 }]);
	});

	it('run backwards for undo', () => {
		const fwd = keyframes(row, card, { reduced: false });
		expect(keyframes(row, card, { reduced: false, reverse: true })).toEqual([fwd[1], fwd[0]]);
	});
});

describe('the stagger', () => {
	it('starts each card 40 ms after the one before, and each takes the same time', () => {
		expect([0, 1, 2].map((i) => timing(i, { reduced: false }))).toEqual([
			{ delay: 0, duration: FLY_MS },
			{ delay: STAGGER_MS, duration: FLY_MS },
			{ delay: 2 * STAGGER_MS, duration: FLY_MS },
		]);
		expect(STAGGER_MS).toBe(40);
	});

	it('stops growing after a score of cards', () => {
		expect(timing(STAGGER_CAP + 30, { reduced: false }).delay).toBe(STAGGER_CAP * STAGGER_MS);
	});

	it('is a 150 ms fade for all of them together with reduced motion', () => {
		expect(timing(0, { reduced: true })).toEqual({ delay: 0, duration: 150 });
		expect(timing(7, { reduced: true })).toEqual({ delay: 0, duration: FADE_MS });
	});
});

describe('planning a fly', () => {
	const landed = new Map<string, Rect | null>([['a', rect(800, 100, 220, 100)], ['b', rect(800, 240, 220, 100)], ['c', null]]);
	const picked = [{ id: 'a', rect: rect(100, 400, 600, 40) }, { id: 'b', rect: null }, { id: 'c', rect: rect(100, 450, 600, 40) }, { id: 'd', rect: null }];

	it('pairs the rows with where the cards landed, leaving out cards that did not land on screen', () => {
		expect(cardsOf(picked, landed).map((c) => [c.id, !!c.first])).toEqual([['a', true], ['b', false]]);
	});

	it('is one step per card in the order picked, with its delay', () => {
		const steps = planFly(cardsOf(picked, landed), { reduced: false });
		expect(steps.map((s) => [s.id, s.delay])).toEqual([['a', 0], ['b', 40]]);
		expect(totalMs(steps)).toBe(40 + FLY_MS);
		expect(totalMs([])).toBe(0);
	});

	it('with reduced motion is all fades, together', () => {
		const steps = planFly(cardsOf(picked, landed), { reduced: true });
		expect(steps.every((s) => s.delay === 0 && s.duration === FADE_MS)).toBe(true);
		expect(steps[0].keyframes[0]).toEqual({ transform: 'none', opacity: 0 });
	});
});

describe('undo and redo of a pick', () => {
	const log: FlyEntry[] = [{ ids: ['a', 'b'], rects: [null, null] }, { ids: ['c'], rects: [null] }];
	it('find the pick whose samples are exactly what changed', () => {
		expect(entryFor(log, ['b', 'a'])?.ids).toEqual(['a', 'b']);
		expect(entryFor(log, ['c'])?.ids).toEqual(['c']);
	});
	it('are not a fly when it is some other change', () => {
		expect(entryFor(log, ['a'])).toBeNull();
		expect(entryFor(log, ['a', 'b', 'c'])).toBeNull();
		expect(entryFor(log, [])).toBeNull();
	});

	it('read the samples a change took away', () => {
		const item = (id: string) => ({ kind: 'sample', existing: { id } });
		expect(samplesLost({ items: [item('a'), item('b'), { kind: 'sample' }, { kind: 'test' }] }, { items: [item('b')] })).toEqual(['a']);
		expect(samplesLost({ items: [item('a')] }, { items: [item('a')] })).toEqual([]);
	});
});

describe('playing', () => {
	function target() {
		const calls: { id: string; opts: KeyframeAnimationOptions; ghost: boolean }[] = [];
		const removed: string[] = [];
		const el = (id: string, ghost: boolean) => ({
			animate: (_k: Keyframe[], opts: KeyframeAnimationOptions) => {
				calls.push({ id, opts, ghost });
				return { finished: Promise.resolve() } as unknown as Animation;
			},
			remove: () => void removed.push(id),
		});
		const t: FlyTarget = { element: (id) => (id === 'missing' ? null : el(id, false)), ghost: (id) => el(id, true) };
		return { t, calls, removed };
	}
	const steps = planFly([{ id: 'a', first: null, last: rect(0, 0, 1, 1) }, { id: 'missing', first: null, last: rect(0, 0, 1, 1) }, { id: 'b', first: null, last: rect(0, 0, 1, 1) }], { reduced: false });

	it('animates each real card, skipping one that is not drawn, with its delay', async () => {
		const { t, calls } = target();
		await playFly(steps, t);
		expect(calls.map((c) => [c.id, c.opts.delay, c.opts.fill, c.ghost])).toEqual([['a', 0, 'backwards', false], ['b', 80, 'backwards', false]]);
	});

	it('animates ghosts when it runs backwards, and takes them away afterwards', async () => {
		const { t, calls, removed } = target();
		await playFly(steps, t, { reverse: true });
		expect(calls.every((c) => c.ghost && c.opts.fill === 'forwards')).toBe(true);
		expect(removed.sort()).toEqual(['a', 'b', 'missing']);
	});

	it('is done at once with nothing to play', async () => {
		const { t } = target();
		await expect(playFly([], t)).resolves.toBeUndefined();
		const spy = vi.fn();
		await playFly([], { element: spy, ghost: spy as never });
		expect(spy).not.toHaveBeenCalled();
	});
});
