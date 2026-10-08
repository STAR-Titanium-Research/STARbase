import { describe, expect, it } from 'vitest';
import { cropOverrideForUpload, cropWindowSec } from './cropOverride';

const cache = { csSec: 1, ceSec: 9 };

describe('cropWindowSec', () => {
	it('uses the stored override, converted from sample indices', () => {
		expect(cropWindowSec({ fs: 1000, crop_start_idx_override: 2500, crop_end_idx_override: 7000 }, cache))
			.toEqual({ startSec: 2.5, endSec: 7, overridden: true });
	});
	it('is the cache detection when only one side is stored: an override is both sides or neither', () => {
		expect(cropWindowSec({ fs: 1000, crop_start_idx_override: 2500 }, cache)).toEqual({ startSec: 1, endSec: 9, overridden: false });
	});
	it('is the cache detection when nothing is stored or the rate is unknown', () => {
		expect(cropWindowSec({ fs: 1000 }, cache)).toEqual({ startSec: 1, endSec: 9, overridden: false });
		expect(cropWindowSec({ crop_start_idx_override: 5 }, cache)).toEqual({ startSec: 1, endSec: 9, overridden: false });
	});
	it('reads the rate from the config when the summary has no fs', () => {
		expect(cropWindowSec({ config: { sample_rate: 500 }, crop_start_idx_override: 1000, crop_end_idx_override: 2000 }, cache).startSec).toBe(2);
	});
});

describe('cropOverrideForUpload', () => {
	it('is null when nothing is stored', () => {
		expect(cropOverrideForUpload({ fs: 1000 })).toBeNull();
		expect(cropOverrideForUpload(null)).toBeNull();
	});
	it('passes both stored sides through', () => {
		expect(cropOverrideForUpload({ crop_start_idx_override: 1, crop_end_idx_override: 2 })).toEqual({ start: 1, end: 2 });
	});
	it('is null for a half-set pair: nothing is filled in from the cache', () => {
		expect(cropOverrideForUpload({ fs: 1000, crop_end_idx_override: 5000 })).toBeNull();
		expect(cropOverrideForUpload({ fs: 1000, crop_start_idx_override: 5 })).toBeNull();
	});
});
