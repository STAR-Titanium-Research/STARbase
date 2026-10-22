// The FAST (sintering) profile: what FastDashboard hard-wired before profiles existed, moved here unchanged.
import { loadTrace } from '../fastCache';
import { MOULD_LABELS, PEAK_LABELS, buildDetailRows, buildHeader, buildOpMeta, buildStats, dataQuality } from '../fastMeta';
import { SEED_GROUP_ORDER } from '../fastTiles';
import type { RunProfile } from '../profile';

// A row stuck at pending/processing for more than a short grace period almost always means the host FAST
// importer (fast_orchestrator.py --daemon) isn't running: nothing will ever claim it. Say so instead of
// leaving an indefinite "importing".
const STALLED_MS = 30_000;
const importStalled = (fr: any, now: number): boolean =>
	!!fr && (fr.status === 'pending' || fr.status === 'processing') && !!fr.updated_at && now - new Date(fr.updated_at).getTime() > STALLED_MS;

export const fastProfile: RunProfile = {
	key: 'fast',
	title: 'FAST plotter',
	heading: 'FAST Analysis',
	layoutKey: 'd1-fast-dashboard-v1',   // tiles and selectedId as before; the old column widths are ignored
	listQuery: {
		category: 'sintering',
		fields: ['operation_id', 'pass_code', 'operation_date', 'operator_name',
			'sintering_max_temp_celsius', 'sintering_max_force_kn', 'sintering_recipe_number',
			'sample_id.sample_code', 'sample_id.nickname', 'material_id.common_name', 'equipment_id.equipment_name',
			'fast_run.status', 'fast_run.n_rows'],
	},
	detailFields: ['*', 'equipment_id.equipment_name', 'method_id.method_name',
		'material_id.common_name', 'sample_id.sample_code', 'sample_id.nickname', 'sample_id.sample_id',
		'fast_recipe_id.id', 'fast_recipe_id.name', 'fast_recipe_id.program_nr',
		'fast_recipe_id.machine', 'fast_recipe_id.group_name', 'fast_recipe_id.source_file',
		'fast_recipe_id.target_temp_c', 'fast_recipe_id.target_force_kn', 'fast_recipe_id.hold_time_min'],
	seedGroups: SEED_GROUP_ORDER,
	tabs: ['stats', 'detail', 'recipe'],

	quality: dataQuality,
	listMeta: (r) => [
		r.sintering_max_temp_celsius ? `${Math.round(r.sintering_max_temp_celsius)} °C` : '',
		r.sintering_max_force_kn ? `${+Number(r.sintering_max_force_kn).toFixed(1)} kN` : '',
	].filter(Boolean),

	async loadRun(api, operationId) {
		const res = await api.get('/items/fast_run_data', {
			params: {
				filter: { operation_id: { _eq: operationId } },
				fields: ['id', 'status', 'machine_format', 'recipe', 'run_start', 'n_rows', 'duration_s', 'series', 'summary', 'directus_files_id', 'error_message', 'updated_at'],
				limit: 1,
			},
		});
		return res.data?.data?.[0] ?? null;
	},
	async loadTrace(api, run: any) {
		if (run?.status !== 'done' || !run.directus_files_id) return null;
		return loadTrace(run.directus_files_id, run.series || [], async () => {
			const res = await api.get(`/assets/${run.directus_files_id}`, { responseType: 'text' });
			return res.data as string;
		});
	},
	seriesOf: (run: any) => run?.series || [],
	buildOpMeta: (op) => buildOpMeta(op),
	buildStats: (op, run) => buildStats(op, run),
	peakLabels: PEAK_LABELS,
	factLabels: MOULD_LABELS,
	headerFacts: (op) => {
		const h = buildHeader(op);
		return [['Date', h.date], ['Machine', h.machine], ['Operator', h.operator], ['Atmosphere', h.atmosphere]];
	},
	detailRows: (op, run) => buildDetailRows(op, run),
	plotMessage(run: any, now) {
		const st = run?.status;
		if (st === 'pending' || st === 'processing') return importStalled(run, now) ? 'Still importing. Is the FAST importer running on the host?' : 'The trace is being imported.';
		if (st === 'error') return `Import failed: ${run?.error_message || 'unknown error'}`;
		return run ? 'No trace to plot.' : 'No trace was imported for this run.';
	},
	noTraceMessage(run: any) {
		const st = run?.status;
		return st === 'pending' || st === 'processing' ? 'The trace is being imported.' : st === 'error' ? 'The trace import failed.' : 'No trace was imported for this run.';
	},
	traceReady: (run: any) => run?.status === 'done',
};
