import { describe, expect, it } from 'vitest';
import type { HostApi } from '@d1/ui';
import { useGearStatus } from './useGearStatus';

function setup(fail: boolean) {
	const calls: string[] = [];
	const state = { fail };
	const api = {
		get: async (path: string) => {
			calls.push(path);
			if (state.fail) throw new Error('403');
			return { data: { data: [{ tool_id: 't1', tool_name: 'Holder', is_active: false }] } };
		},
	} as unknown as HostApi;
	return { gear: useGearStatus(api), calls, state };
}

describe('gear state reads', () => {
	it('reads each piece of gear once and says what is wrong with it', async () => {
		const { gear, calls } = setup(false);
		await gear.ensure([{ tool_id: 't1' }]);
		await gear.ensure([{ tool_id: 't1' }, { tool_id: 't1' }]);
		expect(calls).toEqual(['/items/tools']);
		expect(gear.problem('tool_id', 't1')).toBe('The tool Holder is retired.');
	});

	it('does not repeat a read that failed on every change of the draft, only after the draft changed (forget)', async () => {
		const { gear, calls, state } = setup(true);
		for (let i = 0; i < 5; i++) await gear.ensure([{ tool_id: 't1' }]); // five keystrokes in the rail
		expect(calls).toHaveLength(1);
		expect(gear.problem('tool_id', 't1')).toBeUndefined();
		state.fail = false;
		await gear.ensure([{ tool_id: 't1' }]);
		expect(calls).toHaveLength(1); // still left alone
		gear.forget();
		await gear.ensure([{ tool_id: 't1' }]);
		expect(calls).toHaveLength(2);
		expect(gear.problem('tool_id', 't1')).toBe('The tool Holder is retired.');
	});
});
