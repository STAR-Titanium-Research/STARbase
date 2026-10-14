// The Force Crawler page's rules as plain functions (no Vue, no network), so they can be tested: which
// state the page is in for this person, how the settings form maps to and from force_crawler_state, and
// how the queue is counted. Ported from the Data Studio module core/extensions/d1-force-crawler.

// The page is for admins. adminKnown is false until the server has answered: while it is, a hard reload
// as an admin must not be told "admins only" on the strength of the starting guess.
export type CrawlerAccess = 'checking' | 'allowed' | 'denied';

export function crawlerAccess(adminKnown: boolean, isAdmin: boolean): CrawlerAccess {
	if (!adminKnown) return 'checking';
	return isAdmin ? 'allowed' : 'denied';
}

export interface CrawlerDraft {
	workers: number;
	throttle_seconds: number;
	file_like: string;
	op_code_like: string;
	series_points: number;
	fft_points: number;
	frm_downsample_step: number;
	frm_dpi: number;
	live_cache_points: number;
	pulses_per_rev: number;
	grid_density: number;
	grid_method: string;
	octree_threshold: number;
	octree_min_node_px: number;
	octree_budget_cap: number;
	grid_pregen: boolean;
}

export const DEFAULT_DRAFT: CrawlerDraft = {
	workers: 2, throttle_seconds: 5, file_like: '', op_code_like: '',
	series_points: 3000, fft_points: 3000, frm_downsample_step: 5, frm_dpi: 300,
	live_cache_points: 250000, pulses_per_rev: 1,
	grid_density: 2048, grid_method: 'splat', octree_threshold: 5000000,
	octree_min_node_px: 1, octree_budget_cap: 25000000, grid_pregen: false,
};

// One force_crawler_state row (the singleton) as the form shows it. A column an older row lacks gets the
// same fallback the daemon uses.
export function draftFromState(s: Record<string, any>): CrawlerDraft {
	return {
		workers: s.workers,
		throttle_seconds: Number(s.throttle_seconds),
		file_like: s.file_like || '',
		op_code_like: s.op_code_like || '',
		series_points: s.series_points,
		fft_points: s.fft_points,
		frm_downsample_step: s.frm_downsample_step,
		frm_dpi: s.frm_dpi,
		live_cache_points: s.live_cache_points,
		pulses_per_rev: s.pulses_per_rev,
		grid_density: s.grid_density ?? 2048,
		grid_method: s.grid_method ?? 'splat',
		octree_threshold: s.octree_threshold ?? s.live_cache_points,
		octree_min_node_px: Number(s.octree_min_node_px ?? 1),
		octree_budget_cap: s.octree_budget_cap ?? 25000000,
		grid_pregen: !!s.grid_pregen,
	};
}

// The PATCH body for Save: every number clamped to what the daemon accepts, an empty scope sent as null.
export function settingsPayload(d: CrawlerDraft): Record<string, unknown> {
	return {
		workers: Number(d.workers) || 1,
		throttle_seconds: Number(d.throttle_seconds) || 0,
		file_like: d.file_like || null,
		op_code_like: d.op_code_like || null,
		series_points: Math.max(100, Number(d.series_points) || 3000),
		fft_points: Math.max(100, Number(d.fft_points) || 3000),
		frm_downsample_step: Math.max(1, Number(d.frm_downsample_step) || 5),
		frm_dpi: Math.max(72, Number(d.frm_dpi) || 300),
		live_cache_points: Math.max(1000, Number(d.live_cache_points) || 250000),
		pulses_per_rev: Math.max(1, Number(d.pulses_per_rev) || 1),
		grid_density: Math.min(8192, Math.max(16, Number(d.grid_density) || 2048)),
		grid_method: d.grid_method === 'natural' ? 'natural' : 'splat',
		octree_threshold: Math.max(1000, Number(d.octree_threshold) || 5000000),
		octree_min_node_px: Math.max(0.1, Number(d.octree_min_node_px) || 1),
		octree_budget_cap: Math.max(1000000, Number(d.octree_budget_cap) || 25000000),
		grid_pregen: !!d.grid_pregen,
	};
}

// The daemon beats about every 10 s; a heartbeat older than this means it is not running.
export const HEARTBEAT_MAX_MS = 30_000;

export function isOnline(s: { last_heartbeat_at?: string | null } | null | undefined, now: number = Date.now()): boolean {
	if (!s?.last_heartbeat_at) return false;
	return now - new Date(s.last_heartbeat_at).getTime() < HEARTBEAT_MAX_MS;
}

export const isRunning = (s: { desired_state?: string } | null | undefined): boolean => s?.desired_state === 'running';
export const nextDesiredState = (s: { desired_state?: string } | null | undefined): 'running' | 'paused' => (isRunning(s) ? 'paused' : 'running');

export const STAT_ORDER = ['pending', 'processing', 'done', 'error', 'skipped'] as const;

// The grouped count GET /items/machining_force_analysis?aggregate[count]=*&groupBy[]=status returns.
export function queueCounts(rows: Array<{ status: string; count: number | string }> | null | undefined): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows ?? []) counts[row.status] = Number(row.count);
	return counts;
}

export const totalQueued = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

// Rows the daemon is working on right now ('processing') are never reset: that would queue the same file a
// second time and run it twice. They are filtered out of both recrawl queries. So are rows with no source
// .mat (a Force App cut over the recorder's size limit): the daemon has nothing to process, and resetting
// one would turn a good analysis into an error.
export const NOT_PROCESSING = { _and: [{ status: { _neq: 'processing' } }, { directus_files_id: { _nnull: true } }] };

export function recrawlFilter(query: string): Record<string, unknown> {
	return {
		_and: [
			NOT_PROCESSING,
			{ _or: [{ 'operation_id.pass_code': { _icontains: query } }, { 'operation_id.sample_id.sample_code': { _icontains: query } }] },
		],
	};
}

// The batch PATCH that puts rows back on the queue.
export const resetBody = (keys: string[]) => ({ keys, data: { status: 'pending', error_message: null } });

export function fmtTime(v: string | null | undefined): string {
	if (!v) return '—';
	return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function opLabel(r: { id: string; operation_id?: { pass_code?: string | null; sample_id?: { sample_code?: string | null } | null } | null }): string {
	return r.operation_id?.pass_code || r.operation_id?.sample_id?.sample_code || r.id;
}
