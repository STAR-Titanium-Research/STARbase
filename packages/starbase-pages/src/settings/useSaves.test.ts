import { describe, expect, it } from 'vitest';
import { useSaves } from './useSaves';

describe('useSaves', () => {
	it('marks a control failed when its job says the change did not stick', async () => {
		const saves = useSaves();
		await saves.run('theme', async () => false);
		expect(saves.hasFailed('theme')).toBe(true);
		expect(saves.hasFailed('other')).toBe(false);
	});
	it('treats a job that throws as a failure', async () => {
		const saves = useSaves();
		await saves.run('theme', async () => {
			throw new Error('boom');
		});
		expect(saves.hasFailed('theme')).toBe(true);
	});
	it('retry runs the same job again and clears the failure when it sticks', async () => {
		const saves = useSaves();
		let calls = 0;
		await saves.run('pins', async () => ++calls > 1);
		expect(saves.hasFailed('pins')).toBe(true);
		await saves.retry('pins');
		expect(calls).toBe(2);
		expect(saves.hasFailed('pins')).toBe(false);
	});
	it('a later success under the key clears the failure', async () => {
		const saves = useSaves();
		await saves.run('autoCollapse', async () => false);
		await saves.run('autoCollapse', async () => true);
		expect(saves.hasFailed('autoCollapse')).toBe(false);
	});
	it('retry of an unknown key does nothing', async () => {
		await expect(useSaves().retry('nothing')).resolves.toBeUndefined();
	});
});
