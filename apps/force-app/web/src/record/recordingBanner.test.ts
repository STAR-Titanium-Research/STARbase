import { describe, expect, it } from 'vitest';
import { bannerRunFromStatus } from './recordingBanner';

describe('bannerRunFromStatus', () => {
	it('shows a recording run', () => {
		const r = bannerRunFromStatus({ state: 'recording', id: 'c1', config: { sample_name: 'S1' }, n_total: 10, elapsed_sec: 2, peaks: { Fx: -5, Fy: 1, Fz: 3 } });
		expect(r).toMatchObject({ id: 'c1', sampleName: 'S1', samples: 10, peakN: 5, phase: 'recording', elapsedSec: 2 });
	});
	it('also shows a run that is still being saved', () => {
		expect(bannerRunFromStatus({ state: 'finalizing', id: 'c2' })).toMatchObject({ id: 'c2', sampleName: 'c2', phase: 'finalizing' });
	});
	it('shows nothing once settled or idle', () => {
		for (const state of ['idle', 'done', 'error', undefined]) expect(bannerRunFromStatus({ state, id: 'x' })).toBeNull();
		expect(bannerRunFromStatus(null)).toBeNull();
	});
});
