import { describe, expect, it } from 'vitest';
import {
	DEFAULT_DRAFT, HEARTBEAT_MAX_MS, NOT_PROCESSING, STAT_ORDER, crawlerAccess, draftFromState, isOnline, isRunning, nextDesiredState, opLabel,
	queueCounts, recrawlFilter, resetBody, settingsPayload, totalQueued,
} from './crawlerModel';

describe('crawlerAccess (the admin gate)', () => {
	it('waits for the server before deciding, so an admin on a hard reload is not bounced', () => {
		expect(crawlerAccess(false, false)).toBe('checking');
		expect(crawlerAccess(false, true)).toBe('checking');
	});
	it('admits an admin and refuses everyone else once known', () => {
		expect(crawlerAccess(true, true)).toBe('allowed');
		expect(crawlerAccess(true, false)).toBe('denied');
	});
});

describe('settings form', () => {
	const row = {
		workers: 4, throttle_seconds: '2.5', file_like: null, op_code_like: '%MT-F%', series_points: 4000, fft_points: 3000,
		frm_downsample_step: 5, frm_dpi: 300, live_cache_points: 250000, pulses_per_rev: 2,
		grid_density: null, grid_method: null, octree_threshold: null, octree_min_node_px: '0.5', octree_budget_cap: null, grid_pregen: 1,
	};
	it('reads a state row into the draft, with the daemon fallbacks for missing columns', () => {
		expect(draftFromState(row)).toEqual({
			workers: 4, throttle_seconds: 2.5, file_like: '', op_code_like: '%MT-F%', series_points: 4000, fft_points: 3000,
			frm_downsample_step: 5, frm_dpi: 300, live_cache_points: 250000, pulses_per_rev: 2,
			grid_density: 2048, grid_method: 'splat', octree_threshold: 250000, octree_min_node_px: 0.5, octree_budget_cap: 25000000, grid_pregen: true,
		});
	});
	it('saves the defaults as they are, with empty scopes as null', () => {
		const p = settingsPayload(DEFAULT_DRAFT);
		expect(p.file_like).toBeNull();
		expect(p.op_code_like).toBeNull();
		expect(p.workers).toBe(2);
		expect(p.grid_method).toBe('splat');
		expect(p.grid_pregen).toBe(false);
	});
	it('clamps every number to what the daemon accepts', () => {
		const p = settingsPayload({
			...DEFAULT_DRAFT, workers: 0, series_points: 5, fft_points: -1, frm_downsample_step: 0, frm_dpi: 10, live_cache_points: 1, pulses_per_rev: 0,
			grid_density: 99999, octree_threshold: 5, octree_min_node_px: 0.01, octree_budget_cap: 5, throttle_seconds: Number.NaN,
		});
		expect(p).toMatchObject({
			workers: 1, series_points: 100, fft_points: 100, frm_downsample_step: 5, frm_dpi: 72, live_cache_points: 1000, pulses_per_rev: 1,
			grid_density: 8192, octree_threshold: 1000, octree_min_node_px: 0.1, octree_budget_cap: 1000000, throttle_seconds: 0,
		});
		expect(settingsPayload({ ...DEFAULT_DRAFT, grid_density: 3 }).grid_density).toBe(16);
	});
	it('knows only the two grid methods', () => {
		expect(settingsPayload({ ...DEFAULT_DRAFT, grid_method: 'natural' }).grid_method).toBe('natural');
		expect(settingsPayload({ ...DEFAULT_DRAFT, grid_method: 'bogus' }).grid_method).toBe('splat');
	});
});

describe('daemon state', () => {
	const now = Date.parse('2026-10-14T12:00:00Z');
	it('is online while the heartbeat is recent', () => {
		expect(isOnline({ last_heartbeat_at: '2026-10-14T11:59:50Z' }, now)).toBe(true);
		expect(isOnline({ last_heartbeat_at: new Date(now - HEARTBEAT_MAX_MS).toISOString() }, now)).toBe(false);
		expect(isOnline({ last_heartbeat_at: null }, now)).toBe(false);
		expect(isOnline(null, now)).toBe(false);
	});
	it('toggles between running and paused', () => {
		expect(isRunning({ desired_state: 'running' })).toBe(true);
		expect(nextDesiredState({ desired_state: 'running' })).toBe('paused');
		expect(nextDesiredState({ desired_state: 'paused' })).toBe('running');
		expect(nextDesiredState(null)).toBe('running');
	});
});

describe('queue', () => {
	it('counts rows by status', () => {
		const counts = queueCounts([{ status: 'done', count: '12' }, { status: 'error', count: 3 }]);
		expect(counts).toEqual({ done: 12, error: 3 });
		expect(totalQueued(counts)).toBe(15);
		expect(queueCounts(null)).toEqual({});
		expect(STAT_ORDER).toEqual(['pending', 'processing', 'done', 'error', 'skipped']);
	});
	it('never resets a row being processed or one with no source file', () => {
		expect(NOT_PROCESSING).toEqual({ _and: [{ status: { _neq: 'processing' } }, { directus_files_id: { _nnull: true } }] });
		expect(JSON.stringify(recrawlFilter('MT-F'))).toContain('"_neq":"processing"');
		expect(JSON.stringify(recrawlFilter('MT-F'))).toContain('"_icontains":"MT-F"');
	});
	it('puts rows back to pending and clears the error in one batch body', () => {
		expect(resetBody(['a', 'b'])).toEqual({ keys: ['a', 'b'], data: { status: 'pending', error_message: null } });
	});
	it('labels a row by pass code, else sample code, else id', () => {
		expect(opLabel({ id: '1', operation_id: { pass_code: 'MT-F-1', sample_id: { sample_code: 'S' } } })).toBe('MT-F-1');
		expect(opLabel({ id: '1', operation_id: { pass_code: null, sample_id: { sample_code: 'S' } } })).toBe('S');
		expect(opLabel({ id: '1', operation_id: null })).toBe('1');
	});
});
