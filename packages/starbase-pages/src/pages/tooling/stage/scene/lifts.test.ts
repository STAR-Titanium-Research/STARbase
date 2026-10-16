import { describe, expect, it } from 'vitest';
import { HOVER_LIFT_MM, LIFT_MM, liftTargets, liftTiming, LiftMotion } from './lifts';
import { FLIGHT_MS, HOVER_DOWN_MS, HOVER_UP_MS } from './motion';

const box = { kind: 'box' } as const;
const insert = (id: string) => ({ kind: 'insert', insertId: id }) as const;
const hover = (id: string) => ({ kind: 'insert', insertId: id }) as const;

describe('liftTargets', () => {
	it('raises the focused insert fully, whatever the focus level', () => {
		expect(liftTargets(box).size).toBe(0);
		expect([...liftTargets(insert('a'))]).toEqual([['a', LIFT_MM]]);
		expect([...liftTargets({ kind: 'edge', insertId: 'a', edgeId: 'e' })]).toEqual([['a', LIFT_MM]]);
	});

	it('raises a hovered insert a little, 2 to 2.5 mm, and only an insert', () => {
		expect(HOVER_LIFT_MM).toBeGreaterThanOrEqual(2);
		expect(HOVER_LIFT_MM).toBeLessThanOrEqual(2.5);
		expect([...liftTargets(box, hover('a'))]).toEqual([['a', HOVER_LIFT_MM]]);
		expect(liftTargets(box, { kind: 'edge', insertId: 'a', edgeId: 'e' }).size).toBe(0); // an edge pill is not a hover lift
		expect(liftTargets(box, null).size).toBe(0);
	});

	it('keeps a hovered insert that is already lifted at the full lift, and lifts a second hovered one a little', () => {
		expect(liftTargets(insert('a'), hover('a')).get('a')).toBe(LIFT_MM);
		const both = liftTargets(insert('a'), hover('b'));
		expect(both.get('a')).toBe(LIFT_MM);
		expect(both.get('b')).toBe(HOVER_LIFT_MM);
	});
});

describe('liftTiming', () => {
	it('gives a full lift or drop the camera flight\'s duration, so the insert rises in step with it', () => {
		expect(liftTiming(0, LIFT_MM, false).ms).toBe(FLIGHT_MS);
		expect(liftTiming(LIFT_MM, 0, false).ms).toBe(FLIGHT_MS);
		expect(liftTiming(HOVER_LIFT_MM, LIFT_MM, false).ms).toBe(FLIGHT_MS);
	});

	it('makes a hover rise about 150 ms and a settle about 200 ms, and a part way move shorter', () => {
		expect(HOVER_UP_MS).toBe(150);
		expect(HOVER_DOWN_MS).toBe(200);
		expect(liftTiming(0, HOVER_LIFT_MM, false).ms).toBe(150);
		expect(liftTiming(HOVER_LIFT_MM, 0, false).ms).toBe(200);
		expect(liftTiming(1, 0, false).ms).toBeLessThan(200);
		expect(liftTiming(1, 0, false).ms).toBeGreaterThan(0);
	});

	it('is a little shorter under reduced motion, never zero', () => {
		expect(liftTiming(0, LIFT_MM, true).ms).toBeCloseTo(FLIGHT_MS * 0.75, 9);
		expect(liftTiming(0, HOVER_LIFT_MM, true).ms).toBeCloseTo(HOVER_UP_MS * 0.75, 9);
		expect(liftTiming(0, HOVER_LIFT_MM, true).ms).toBeGreaterThan(0);
	});
});

describe('LiftMotion', () => {
	const go = (m: LiftMotion, targets: Array<[string, number]>, now: number, reduced = false) => m.retarget(new Map(targets), now, { reduced });

	it('rests at 0 with nothing out of its pocket', () => {
		const m = new LiftMotion();
		expect(m.sample(0).size).toBe(0);
		expect(m.moving).toBe(false);
	});

	it('eases an insert up over the flight duration, smoothly, and stops at the lift', () => {
		const m = new LiftMotion();
		go(m, [['a', LIFT_MM]], 1000);
		expect(m.moving).toBe(true);
		expect(m.sample(1000).get('a') ?? 0).toBeCloseTo(0, 9);
		expect(m.sample(1000 + FLIGHT_MS / 2).get('a')).toBeCloseTo(LIFT_MM / 2, 6); // in-out: half way at half time
		let last = 0;
		for (let t = 0; t <= FLIGHT_MS; t += 8) {
			const v = m.sample(1000 + t).get('a') ?? 0;
			expect(v).toBeGreaterThanOrEqual(last - 1e-12); // never backs up
			last = v;
		}
		expect(m.sample(1000 + FLIGHT_MS).get('a')).toBe(LIFT_MM);
		expect(m.moving).toBe(false);
	});

	it('is the same at any frame rate: the value is a function of time, not of how often it is asked', () => {
		const a = new LiftMotion();
		const b = new LiftMotion();
		go(a, [['x', LIFT_MM]], 0);
		go(b, [['x', LIFT_MM]], 0);
		for (let t = 0; t < 200; t += 16) a.sample(t); // a is sampled every 16 ms, b not at all until the end
		expect(a.sample(200).get('x')).toBeCloseTo(b.sample(200).get('x')!, 12);
	});

	it('raises the new selection and drops the old one in parallel, each on its own', () => {
		const m = new LiftMotion();
		m.retarget(new Map([['a', LIFT_MM]]), 0, { instant: true });
		expect(m.sample(0).get('a')).toBe(LIFT_MM);
		go(m, [['b', LIFT_MM]], 100);
		const mid = m.sample(100 + FLIGHT_MS / 2);
		expect(mid.get('a')).toBeCloseTo(LIFT_MM / 2, 6);
		expect(mid.get('b')).toBeCloseTo(LIFT_MM / 2, 6);
		const end = m.sample(100 + FLIGHT_MS);
		expect(end.has('a')).toBe(false); // back in its pocket
		expect(end.get('b')).toBe(LIFT_MM);
	});

	it('moves several at once on their own clocks (a hover rise finishes before a flight)', () => {
		const m = new LiftMotion();
		go(m, [['sel', LIFT_MM], ['hov', HOVER_LIFT_MM]], 0);
		const t = HOVER_UP_MS + 5;
		const s = m.sample(t);
		expect(s.get('hov')).toBe(HOVER_LIFT_MM); // done
		expect(s.get('sel')!).toBeLessThan(LIFT_MM); // still going
		expect(m.moving).toBe(true);
	});

	it('chains a change of mind from the in-between value, with no jump', () => {
		const m = new LiftMotion();
		go(m, [['a', LIFT_MM]], 0);
		const mid = m.sample(FLIGHT_MS * 0.3).get('a')!;
		go(m, [], FLIGHT_MS * 0.3); // dropped again before it arrived
		expect(m.sample(FLIGHT_MS * 0.3).get('a')).toBeCloseTo(mid, 9); // starts exactly where it was
		expect(m.sample(FLIGHT_MS * 0.3 + 1000).has('a')).toBe(false);
	});

	it('leaves a move that already goes to the target alone, so re-asking does not restart it', () => {
		const m = new LiftMotion();
		go(m, [['a', LIFT_MM]], 0);
		const before = m.sample(100).get('a');
		go(m, [['a', LIFT_MM]], 100);
		go(m, [['a', LIFT_MM]], 100);
		expect(m.sample(100).get('a')).toBeCloseTo(before!, 12);
		expect(m.sample(FLIGHT_MS).get('a')).toBe(LIFT_MM);
	});

	it('lifts a hovered insert a little and drops it when the pointer leaves, and holds the full lift of a selected one', () => {
		const m = new LiftMotion();
		go(m, [['a', HOVER_LIFT_MM]], 0);
		expect(m.sample(HOVER_UP_MS).get('a')).toBe(HOVER_LIFT_MM);
		go(m, [], 1000); // the pointer left
		expect(m.sample(1000 + HOVER_DOWN_MS).has('a')).toBe(false);
		// hover on an insert that is then selected: on to the full lift, and a hover that ends keeps it there
		go(m, [['a', HOVER_LIFT_MM]], 2000);
		m.sample(2000 + HOVER_UP_MS);
		go(m, [['a', LIFT_MM]], 2300);
		go(m, [['a', LIFT_MM]], 2400); // the hover target is no longer asked for: selection still holds it
		expect(m.sample(2300 + FLIGHT_MS).get('a')).toBe(LIFT_MM);
	});

	it('puts everything where it belongs at once for instant, and drops what is not asked for', () => {
		const m = new LiftMotion();
		go(m, [['a', LIFT_MM]], 0);
		m.retarget(new Map([['b', LIFT_MM]]), 10, { instant: true });
		expect(m.moving).toBe(false);
		const s = m.sample(10);
		expect(s.has('a')).toBe(false);
		expect(s.get('b')).toBe(LIFT_MM);
	});

	it('is never instant under reduced motion: it moves, in 75 % of the time', () => {
		const m = new LiftMotion();
		go(m, [['a', LIFT_MM]], 0, true);
		expect(m.moving).toBe(true);
		expect(m.sample(1).get('a')!).toBeLessThan(LIFT_MM);
		expect(m.sample(FLIGHT_MS * 0.75 - 1).get('a')!).toBeLessThan(LIFT_MM);
		expect(m.sample(FLIGHT_MS * 0.75).get('a')).toBe(LIFT_MM);
	});
});
