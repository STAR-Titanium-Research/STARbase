// @vitest-environment happy-dom
// The Operation page of a Conform run, against a stubbed /items: the "Conform run" entry in "On this page", the section reading the run and
// its log through the kit's helpers, and a reader who may see the run but not its log (Review Focus 5: the summary stays, the log is said to be hidden).
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import { setPageFrame } from '../frame';
import OperationPage from './OperationPage.vue';

const OP = '00000000-0000-4000-8000-0000000000c1';
let app: App | null = null;

const RUN = {
	id: 'r1', operation_id: OP, log_id: 'l1', window_start: '2025-03-17T13:38:20Z', window_end: '2025-03-17T13:53:19Z', status: 'done', error_message: null,
	summary: {
		version: 1, duration_s: 899, n_rows: 900, gaps: 0, extruding_s: 700, mean_wheel_speed_rpm: 8, mean_torque_pct: 25.5, mean_tooling1_c: 450.2, peak_torque_pct: 40,
		peak_motor_current_a: 30.5, peak_tooling1_c: 480, peak_wheel_temp_c: 300, ips_setpoint_c: 300, energy_kwh: { motor: 7, ips: 0.3, cooling: 0.37, total: 7.67 },
		avg_demand_kw: 30.7, missing: [],
	},
	steps: [{ start: '2025-03-17T13:38:20Z', end: '2025-03-17T13:45:00Z', duration_s: 400, ips_setpoint_c: 250, wheel_speed_rpm: 5, wheel_temp_c: null, tooling1_c: null, tooling2_c: null, mean_torque_pct: 22.5, energy_kwh: 3.5 }],
};
const LOG = {
	log_id: 'l1', directus_files_id: 'f1', equipment_id: 'e1', source_filename: 'TiSwarf.csv', log_start: '2025-03-17T13:00:00Z', log_end: '2025-03-17T15:00:00Z', n_rows: 7200,
	duration_s: 7199, series: [], constants: { voltage_v: 400, cos_phi_motor: 0.85, k_ips: 0.95, cos_phi_cooling: 0.8, version: 1 },
	totals: { duration_s: 7199, energy_kwh: { motor: 44.57, ips: 0.78, cooling: 0.17, total: 45.52 }, avg_demand_kw: 22.8, missing: [] },
};

async function mountOperation(opts: { category?: string; logVisible?: boolean }) {
	const calls: string[] = [];
	const get = async (url: string) => {
		calls.push(url);
		if (url === `/items/manufacturing_operations/${OP}`) {
			return { data: { data: { operation_id: OP, pass_code: '17-03-25-CF-012-8dia', process_category: opts.category ?? 'conform', operation_date: '2025-03-17T00:00:00Z', equipment_id: { equipment_id: 'e1', equipment_name: 'Conform' } } } };
		}
		if (url === '/items/conform_run_data') return { data: { data: [RUN] } };
		if (url === '/items/conform_logs/l1') {
			if (opts.logVisible === false) throw Object.assign(new Error('403'), { response: { status: 403 } });
			return { data: { data: LOG } };
		}
		if (url.startsWith('/assets/')) throw Object.assign(new Error('no file in this test'), { response: { status: 404 } });
		return { data: { data: [] } };
	};
	setExplorerHostFactory(() => ({ api: { get, post: async () => ({}), patch: async () => ({}), delete: async () => ({}) } as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), user: ref({ id: 'u', role: 'r' }) }) as any);
	setPageFrame(defineComponent({ props: { title: String }, setup: (_p, { slots }) => () => h('div', slots.default?.()) }));
	window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	await router.push('/');
	app = createApp({ render: () => h(OperationPage, { id: OP }) });
	app.use(router);
	const Nothing = defineComponent({ setup: () => () => null });
	for (const n of ['v-button', 'v-icon', 'v-input', 'v-notice', 'v-progress-circular', 'v-chip']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', slots.default?.()) }));
	for (const n of ['v-dialog', 'v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-drawer', 'v-form']) app.component(n, Nothing);
	app.directive('tooltip', {});
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 10));
	await nextTick();
	return { calls };
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? '';

afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	setPageFrame(null);
	document.body.innerHTML = '';
});

describe('the Operation page of a Conform run', () => {
	it('has a "Conform run" entry in "On this page" and a section with the run and its log', async () => {
		await mountOperation({});
		expect(document.querySelector('#conform-run')).toBeTruthy();
		// the section's own heading, and its entry in "On this page" (the rail lists each section by title)
		const entries = [...document.querySelectorAll('a, button, li')].filter((n) => n.textContent?.trim().startsWith('Conform run') && !n.closest('#conform-run'));
		expect(entries.length).toBeGreaterThan(0);
		expect(text()).toContain('7.67 kWh');
		expect(text()).toContain('45.52 kWh'); // the whole log
		expect(text()).toContain('Open in Conform plotter');
	});

	it('a reader who may see the run but not its log still gets the summary and steps, and is told the log is hidden', async () => {
		await mountOperation({ logVisible: false });
		expect(text()).toContain('Conform log not visible to you');
		expect(text()).toContain('7.67 kWh');
		expect(document.querySelectorAll('tr.step')).toHaveLength(1);
		expect(text()).not.toContain('Whole log');
	});

	it('another category has no Conform section and reads no run', async () => {
		const { calls } = await mountOperation({ category: 'machining' });
		expect(document.querySelector('#conform-run')).toBeNull();
		expect(calls).not.toContain('/items/conform_run_data');
	});
});
