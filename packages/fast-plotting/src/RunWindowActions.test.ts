import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import RunWindowActions from './RunWindowActions.vue';
import { resetFastHost, setFastHost, type FastHost } from './host';
import { conformProfile } from './profiles/conformProfile';
import type { ConformRunBundle } from './conform';
import type { Trace } from './fastCache';

const trace: Trace = { time: Float64Array.from([0, 1, 2]), n: 3, series: {}, order: [] };
const log = { log_id: 'l1', directus_files_id: 'f1', equipment_id: null, source_filename: 'a.csv', source_sha256: 'x', log_start: '2025-01-15T10:00:00Z', log_end: '2025-01-15T10:15:00Z', n_rows: 900, duration_s: 900, series: [], totals: {} as any, constants: {} as any, run_windows: [] };
const withLog: ConformRunBundle = { run: { id: 'r1', operation_id: 'op-1', log_id: 'l1', window_start: '2025-01-15T10:00:00Z', window_end: '2025-01-15T10:05:00Z', status: 'done', summary: null, steps: null, error_message: null }, log, logHidden: false };
const noLog: ConformRunBundle = { run: null, log: null, logHidden: false };

beforeEach(() => setFastHost({ api: {} as FastHost['api'], openRecord: () => {} }));
afterEach(() => resetFastHost());

const render = (runData: ConformRunBundle, canEdit?: boolean | null) =>
	renderToString(createSSRApp({
		render: () => h(RunWindowActions, { profile: conformProfile, detail: { operation_id: 'op-1' }, runData, trace, zoomStart: null, zoomEnd: null, busy: false, canEdit }),
	}));

describe('the plotter run actions', () => {
	it('offers every action to someone who can edit the run', async () => {
		const empty = await render(noLog, true);
		expect(empty).toContain('Upload a log (.csv)');
		expect(empty).toContain('Use a log already uploaded');
		expect(empty).toContain('Use this view as the run window');
		const linked = await render(withLog, true);
		expect(linked).toContain('Unlink log');
		expect(linked).toContain('Replace log');
		expect(linked).toContain('Use this view as the run window');
	});

	it('still offers them while the answer is not known (the server decides)', async () => {
		for (const unknown of [null, undefined]) {
			const html = await render(noLog, unknown);
			expect(html).toContain('Upload a log (.csv)');
			expect(html).toContain('Use a log already uploaded');
		}
	});

	it('shows a reader who cannot edit the window and nothing to press', async () => {
		for (const data of [noLog, withLog]) {
			const html = await render(data, false);
			expect(html).toContain('Run window');
			for (const action of ['Upload a log', 'Use a log already uploaded', 'Use this view as the run window', 'Unlink log', 'Replace log']) {
				expect(html, action).not.toContain(action);
			}
			expect(html).not.toContain('<button');
			expect(html).not.toContain('type="file"');
		}
		expect(await render(withLog, false)).toContain('10:00:00 – 10:05:00');
	});
});
