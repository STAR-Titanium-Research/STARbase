import { describe, expect, it } from 'vitest';
import { createDrawGate } from './drawGate';

describe('createDrawGate (#189: no layer build behind the Save dialog)', () => {
	it('never blocks while not paused', () => {
		const gate = createDrawGate(() => false);
		expect(gate.blocked()).toBe(false);
		expect(gate.takeDirty()).toBe(false);
	});

	it('blocks while paused and asks for exactly one draw when it resumes', () => {
		let paused = true;
		const gate = createDrawGate(() => paused);
		expect(gate.blocked()).toBe(true);
		expect(gate.blocked()).toBe(true);
		expect(gate.takeDirty()).toBe(false); // still paused: nothing to draw yet
		paused = false;
		expect(gate.takeDirty()).toBe(true);
		expect(gate.takeDirty()).toBe(false);
	});

	it('does not draw on resume when nothing asked for a draw while paused', () => {
		let paused = true;
		const gate = createDrawGate(() => paused);
		paused = false;
		expect(gate.takeDirty()).toBe(false);
	});
});
