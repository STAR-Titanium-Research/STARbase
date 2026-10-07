import { describe, expect, it } from 'vitest';
import { sameStage, stageInfo, stageLabel, stageProgress, streamStage } from './loadStage';

describe('stageLabel', () => {
	it('shows download progress as a percentage when the size is known', () => {
		expect(stageLabel({ kind: 'download', loaded: 42, total: 100 })).toBe('Downloading live cache 42%');
		expect(stageProgress({ kind: 'download', loaded: 42, total: 100 })).toBeCloseTo(0.42);
	});
	it('falls back to bytes received, then to a bare label, when the size is unknown', () => {
		expect(stageLabel({ kind: 'download', loaded: 2.5 * 1048576, total: null })).toBe('Downloading live cache 2.5 MB');
		expect(stageLabel({ kind: 'download', loaded: 12.3 * 1048576, total: null })).toBe('Downloading live cache 12 MB');
		expect(stageLabel({ kind: 'download', loaded: 0, total: null })).toBe('Downloading live cache…');
		expect(stageProgress({ kind: 'download', loaded: 5, total: null })).toBeNull();
		expect(stageProgress({ kind: 'download', loaded: 5, total: 0 })).toBeNull();
	});
	it('names what is downloading', () => {
		expect(stageLabel({ kind: 'download', loaded: 1, total: 2, what: 'figure' })).toBe('Downloading figure 50%');
	});
	it('never exceeds 100% if a size is under-reported', () => {
		expect(stageLabel({ kind: 'download', loaded: 150, total: 100 })).toBe('Downloading live cache 100%');
	});
	it('names the build and stream stages', () => {
		expect(stageLabel({ kind: 'build' })).toBe('Building cloud…');
		expect(stageLabel({ kind: 'open' })).toBe('Opening full-res octree…');
		expect(stageLabel({ kind: 'stream', fraction: 0.63 })).toBe('Streaming full-res 63%');
		expect(stageLabel({ kind: 'stream', fraction: null })).toBe('Streaming full-res…');
	});
	it('stageInfo is null for no stage', () => {
		expect(stageInfo(null)).toBeNull();
		expect(stageInfo({ kind: 'build' })).toEqual({ label: 'Building cloud…', progress: null });
	});
});

describe('streamStage', () => {
	it('is streaming while points are still arriving', () => {
		expect(streamStage(500_000, 1_000_000, 100)).toEqual({ kind: 'stream', fraction: 0.5 });
	});
	it('waits (no percentage) for the first nodes', () => {
		expect(streamStage(0, 1_000_000, 200)).toEqual({ kind: 'stream', fraction: null });
	});
	it('is done at (nearly) every point', () => {
		expect(streamStage(990_000, 1_000_000, 50)).toBeNull();
	});
	it('is done once the count stops changing, for a budget-capped map that never reaches the total', () => {
		expect(streamStage(600_000, 1_000_000, 1500)).toBeNull();
	});
	it('gives up on a cloud that never shows anything', () => {
		expect(streamStage(0, 1_000_000, 3500)).toBeNull();
	});
	it('without a known total keeps streaming until the count settles', () => {
		expect(streamStage(10_000, undefined, 100)).toEqual({ kind: 'stream', fraction: null });
		expect(streamStage(10_000, undefined, 1500)).toBeNull();
	});
});

describe('sameStage', () => {
	it('compares by what would be shown', () => {
		expect(sameStage({ kind: 'stream', fraction: 0.501 }, { kind: 'stream', fraction: 0.504 })).toBe(true);
		expect(sameStage({ kind: 'stream', fraction: 0.5 }, { kind: 'stream', fraction: 0.52 })).toBe(false);
		expect(sameStage(null, null)).toBe(true);
		expect(sameStage(null, { kind: 'build' })).toBe(false);
	});
});
