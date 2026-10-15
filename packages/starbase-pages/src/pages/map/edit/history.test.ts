import { describe, expect, it } from 'vitest';
import { HISTORY_CAP, canRedo, canUndo, clear, createHistory, push, redo, undo } from './history';

describe('history', () => {
	it('undoes and redoes in order', () => {
		let h = createHistory('a');
		h = push(h, 'b');
		h = push(h, 'c');
		expect([canUndo(h), canRedo(h)]).toEqual([true, false]);
		h = undo(h);
		expect(h.present).toBe('b');
		h = undo(h);
		expect(h.present).toBe('a');
		expect(canUndo(h)).toBe(false);
		expect(undo(h)).toBe(h);
		h = redo(h);
		h = redo(h);
		expect(h.present).toBe('c');
		expect(redo(h)).toBe(h);
	});

	it('a new change drops what could be redone', () => {
		let h = push(push(createHistory(1), 2), 3);
		h = undo(h);
		h = push(h, 9);
		expect(h.present).toBe(9);
		expect(canRedo(h)).toBe(false);
		expect(undo(h).present).toBe(2);
	});

	it('the same value again is no step', () => {
		const body = { a: 1 };
		const h = createHistory(body);
		expect(push(h, body)).toBe(h);
	});

	it(`keeps ${HISTORY_CAP} steps, the oldest are forgotten`, () => {
		let h = createHistory(0);
		for (let i = 1; i <= HISTORY_CAP + 50; i += 1) h = push(h, i);
		expect(h.past).toHaveLength(HISTORY_CAP);
		for (let i = 0; i < HISTORY_CAP; i += 1) h = undo(h);
		expect(h.present).toBe(50);
		expect(canUndo(h)).toBe(false);
	});

	it('does not change the history it is given', () => {
		const h = createHistory('a');
		push(h, 'b');
		expect(h).toEqual({ past: [], present: 'a', future: [] });
	});

	it('clear starts over around the present', () => {
		const h = clear('z');
		expect(canUndo(h) || canRedo(h)).toBe(false);
		expect(h.present).toBe('z');
	});
});
