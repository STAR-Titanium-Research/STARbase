import { describe, expect, it } from 'vitest';
import { createGlLifecycle } from './glLifecycle';

function harness() {
	const log: string[] = [];
	const life = createGlLifecycle({
		teardown: () => log.push('teardown'),
		replaceCanvas: () => log.push('canvas'),
		start: () => log.push('start'),
	});
	return { log, life };
}

describe('createGlLifecycle', () => {
	it('deactivate tears down and suspends; activate swaps the canvas, then starts', () => {
		const { log, life } = harness();
		life.deactivate();
		expect(life.suspended).toBe(true);
		expect(log).toEqual(['teardown']);
		expect(life.activate()).toBe(true);
		expect(life.suspended).toBe(false);
		expect(log).toEqual(['teardown', 'canvas', 'start']);
	});
	it('the activation that follows the first mount is not a restart', () => {
		const { log, life } = harness();
		expect(life.activate()).toBe(false);
		expect(log).toEqual([]);
	});
	it('survives repeated Plot -> Record -> Plot round trips', () => {
		const { log, life } = harness();
		for (let i = 0; i < 3; i++) { life.deactivate(); life.activate(); }
		expect(log).toEqual(Array(3).fill(['teardown', 'canvas', 'start']).flat());
	});
	it('a double deactivate does not tear down twice', () => {
		const { log, life } = harness();
		life.deactivate(); life.deactivate();
		expect(log).toEqual(['teardown']);
	});
	it('unmounting while deactivated still tears down (cache dropped from keep-alive)', () => {
		const { log, life } = harness();
		life.deactivate(); life.unmount();
		expect(log).toEqual(['teardown', 'teardown']);
		expect(life.suspended).toBe(false);
	});
});
