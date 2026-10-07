import { describe, expect, it } from 'vitest';
import { analysisLink, processLabel } from './process';

describe('analysisLink', () => {
	it('sends machining to the Force dashboard', () => {
		expect(analysisLink('op-1', 'machining')).toEqual({
			label: 'View forces',
			to: '/d1-force-dashboard?operation=op-1',
		});
	});

	it('sends sintering to the FAST dashboard', () => {
		expect(analysisLink('op-1', 'sintering')).toEqual({ label: 'View FAST', to: '/d1-fast-dashboard?operation=op-1' });
	});

	it('has no link for the other categories or a missing one', () => {
		expect(analysisLink('op-1', 'heat_treatment')).toBeNull();
		expect(analysisLink('op-1', 'sample_prep')).toBeNull();
		expect(analysisLink('op-1', null)).toBeNull();
	});
});

describe('processLabel', () => {
	it('names the known categories', () => {
		expect(processLabel('sintering')).toBe('FAST sintering');
		expect(processLabel('sample_prep')).toBe('Sample preparation');
	});
	it('falls back for a new or missing category', () => {
		expect(processLabel('cold_spray')).toBe('cold spray');
		expect(processLabel(null)).toBe('Operation');
	});
});
