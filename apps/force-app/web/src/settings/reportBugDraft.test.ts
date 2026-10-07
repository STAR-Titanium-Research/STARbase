import { describe, expect, it } from 'vitest';
import { MAX_AREAS, toggleArea } from './reportBugDraft';

describe('toggleArea (#95)', () => {
	it('adds and removes areas', () => {
		expect(toggleArea(['plotting'], 'recording')).toEqual(['plotting', 'recording']);
		expect(toggleArea(['plotting', 'recording'], 'plotting')).toEqual(['recording']);
	});
	it('never ends up empty', () => {
		expect(toggleArea(['plotting'], 'plotting')).toEqual(['plotting']);
	});
	it('treats General as the catch-all', () => {
		expect(toggleArea(['general'], 'plotting')).toEqual(['plotting']);
		expect(toggleArea(['plotting', 'recording'], 'general')).toEqual(['general']);
	});
	it('caps the selection', () => {
		const four = ['gui', 'recording', 'plotting', 'settings'];
		expect(four).toHaveLength(MAX_AREAS);
		expect(toggleArea(four, 'nidaq')).toEqual(four);
	});
});
