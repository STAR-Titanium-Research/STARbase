import { describe, expect, it } from 'vitest';
import { loadSnapshot } from './labampStore';
import type { LabAmpConfig, LabAmpStatus } from '../record/labampApi';

const STATUS: LabAmpStatus = { reachable: true, mode: 'MEASURE', base_url: 'http://amp', mock: true, channels: 8, config_mode: 'mock' };
const CONFIG: LabAmpConfig = { base_url: 'http://amp', channels: 8, mode: 'mock', autorange_headroom: 1.5 };

describe('loadSnapshot', () => {
	it('requests status and config together, then the sensors', async () => {
		const order: string[] = [];
		let statusDone = false;
		const snap = await loadSnapshot({
			status: async () => { order.push('status'); await Promise.resolve(); statusDone = true; return STATUS; },
			getConfig: async () => { order.push(`config(statusDone=${statusDone})`); return CONFIG; },
			sensors: async () => { order.push('sensors'); return { sensors: [{ channel: 1, name: 'Fx1' }] }; },
		});
		// config was asked for before status had answered: the two no longer run back to back.
		expect(order).toEqual(['status', 'config(statusDone=false)', 'sensors']);
		expect(snap.sensors).toEqual([{ channel: 1, name: 'Fx1' }]);
		expect(snap.config.autorange_headroom).toBe(1.5);
	});

	it('does not ask an unreachable amp for its sensors', async () => {
		let asked = false;
		const snap = await loadSnapshot({
			status: async () => ({ ...STATUS, reachable: false }),
			getConfig: async () => CONFIG,
			sensors: async () => { asked = true; return { sensors: [] }; },
		});
		expect(asked).toBe(false);
		expect(snap.sensors).toEqual([]);
	});
});
