import { describe, expect, it } from 'vitest';
import { pickMode, type ModeInputs } from './frmMode';

const base: ModeInputs = { preferred: 'lite', octreeAvailable: false, liveAvailable: true, fullResPoints: 1000, octreeThreshold: 5_000_000, fast: true };
const pick = (o: Partial<ModeInputs>) => pickMode({ ...base, ...o });

describe('pickMode', () => {
	it('keeps Lite when the op has a live cache', () => {
		expect(pick({})).toBe('lite');
	});
	it('drops Lite to Figure only for an op without a live cache -- and the preference survives it', () => {
		expect(pick({ liveAvailable: false })).toBe('figure');
		// The next op (with a cache) starts from the same preference, not from the forced Figure.
		expect(pick({ liveAvailable: true })).toBe('lite');
	});
	it('Full falls back to Lite on a fast connection, Figure otherwise', () => {
		expect(pick({ preferred: 'full' })).toBe('lite');
		expect(pick({ preferred: 'full', fast: false })).toBe('figure');
		expect(pick({ preferred: 'full', liveAvailable: false })).toBe('figure');
	});
	it('Full when its octree exists', () => {
		expect(pick({ preferred: 'full', octreeAvailable: true })).toBe('full');
	});
	it('auto-routes up to Full for a big map with an octree, whatever the preference', () => {
		expect(pick({ preferred: 'figure', octreeAvailable: true, fullResPoints: 9_000_000 })).toBe('full');
		expect(pick({ preferred: 'figure', octreeAvailable: false, fullResPoints: 9_000_000 })).toBe('figure');
	});
	it('Figure stays Figure', () => {
		expect(pick({ preferred: 'figure' })).toBe('figure');
	});
});
