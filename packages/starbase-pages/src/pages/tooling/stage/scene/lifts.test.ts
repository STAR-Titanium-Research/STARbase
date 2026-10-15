import { describe, expect, it } from 'vitest';
import { LIFT_MM, liftTargets, stepLifts } from './lifts';

describe('liftTargets', () => {
	it('raises only the focused insert', () => {
		expect(liftTargets({ kind: 'box' }).size).toBe(0);
		expect([...liftTargets({ kind: 'insert', insertId: 'a' })]).toEqual([['a', LIFT_MM]]);
		expect([...liftTargets({ kind: 'edge', insertId: 'a', edgeId: 'e' })]).toEqual([['a', LIFT_MM]]);
	});
});

describe('stepLifts', () => {
	it('eases an insert up, and the previous one down at the same time', () => {
		const from = new Map([['a', LIFT_MM]]);
		const to = new Map([['b', LIFT_MM]]);
		const mid = stepLifts(from, to, 0.5);
		expect(mid.get('a')).toBeCloseTo(LIFT_MM / 2, 9);
		expect(mid.get('b')).toBeCloseTo(LIFT_MM / 2, 9);
	});

	it('is the start at 0 and the end at 1, and drops inserts that are back in their pocket', () => {
		const from = new Map([['a', LIFT_MM]]);
		const to = new Map<string, number>();
		expect(stepLifts(from, to, 0).get('a')).toBe(LIFT_MM);
		expect(stepLifts(from, to, 1).has('a')).toBe(false);
	});
});
