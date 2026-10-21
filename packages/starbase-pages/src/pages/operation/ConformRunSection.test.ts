// @vitest-environment happy-dom
// The Operation page's "Conform run" section, with the @d1/fast-plotting helpers that touch the network mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import {
	ConformLogError, CONFORM_POWER_CONSTANTS, linkExistingLog, listCandidateLogs, recomputeRun, setRunWindow, stepsToCsv, uploadConformLog,
	type ConformLogRow, type ConformRunRow, type ConformStep, type ConformSummary,
} from '@d1/fast-plotting';
import { setExplorerHostFactory } from '@d1/ui';
import ConformRunSection from './ConformRunSection.vue';
import type { ConformRunData } from './useOperationData';

vi.mock('@d1/fast-plotting', async (orig) => ({
	...(await orig<typeof import('@d1/fast-plotting')>()),
	setRunWindow: vi.fn(),
	recomputeRun: vi.fn(),
	uploadConformLog: vi.fn(),
	listCandidateLogs: vi.fn(),
	linkExistingLog: vi.fn(),
	loadLogTrace: vi.fn(async () => {
		throw new Error('no trace in these tests');
	}),
}));

const OP = '00000000-0000-4000-8000-0000000000c1';

const summary = (over: Partial<ConformSummary> = {}): ConformSummary => ({
	version: 1, duration_s: 899, n_rows: 900, gaps: 0, extruding_s: 700, mean_wheel_speed_rpm: 8, mean_torque_pct: 25.5, mean_tooling1_c: 450.2,
	peak_torque_pct: 40, peak_motor_current_a: 30.5, peak_tooling1_c: 480, peak_wheel_temp_c: 300, ips_setpoint_c: 300,
	energy_kwh: { motor: 7, ips: 0.3, cooling: 0.37, total: 7.67 }, avg_demand_kw: 30.7, missing: [], ...over,
});
const range = (min: number, max: number) => ({ min, max, range: max - min });
const STEPS: ConformStep[] = [
	{ start: '2025-03-17T13:38:20Z', end: '2025-03-17T13:45:00Z', duration_s: 400, ips_setpoint_c: 250, wheel_speed_rpm: 5, wheel_temp_c: range(100, 120), tooling1_c: range(400, 430), tooling2_c: null, mean_torque_pct: 22.5, energy_kwh: 3.5 },
	{ start: '2025-03-17T13:45:00Z', end: '2025-03-17T13:53:19Z', duration_s: 499, ips_setpoint_c: 300, wheel_speed_rpm: 8, wheel_temp_c: range(120, 150), tooling1_c: range(430, 480), tooling2_c: range(300, 310), mean_torque_pct: 28, energy_kwh: 4.17 },
];
const run = (over: Partial<ConformRunRow> = {}): ConformRunRow => ({
	id: 'r1', operation_id: OP, log_id: 'l1', window_start: '2025-03-17T13:38:20Z', window_end: '2025-03-17T13:53:19Z', status: 'done', summary: summary(), steps: STEPS, error_message: null, ...over,
});
const LOG: ConformLogRow = {
	log_id: 'l1', directus_files_id: 'f1', equipment_id: 'e1', source_filename: 'TiSwarf.csv', log_start: '2025-03-17T13:00:00Z', log_end: '2025-03-17T15:00:00Z', n_rows: 7200,
	duration_s: 7199, series: [], constants: { ...CONFORM_POWER_CONSTANTS },
	totals: { duration_s: 7199, energy_kwh: { motor: 44.57, ips: 0.78, cooling: 0.17, total: 45.52 }, avg_demand_kw: 22.8, missing: [] },
};
const data = (over: Partial<ConformRunData> = {}): ConformRunData => ({ run: run(), log: LOG, logHidden: false, ...over });

let app: App | null = null;
let el: HTMLElement;
let changed = 0;

async function mount(d: ConformRunData | null, props: Record<string, unknown> = {}) {
	setExplorerHostFactory(() => ({ api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never, navigate() {}, openDataStudio() {}, fieldsFor: async () => [] }) as never);
	changed = 0;
	app = createApp({
		render: () => h(ConformRunSection, { operationId: OP, equipmentId: 'e1', operationDate: '2025-03-17T00:00:00Z', state: { data: d, loading: false, error: '' }, onChanged: () => changed++, ...props }),
	});
	for (const n of ['v-button', 'v-icon', 'v-progress-circular']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', { class: n }, slots.default?.()) }));
	el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await nextTick();
}
const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const settle = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
	await nextTick();
};
async function type(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await nextTick();
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	document.body.innerHTML = '';
});

describe('status', () => {
	it('says the run window is not set for a run with a log and no window', async () => {
		await mount(data({ run: run({ status: 'no_window', window_start: null, window_end: null, summary: null, steps: null }) }));
		expect(text()).toContain('Run window not set');
		expect(text()).toContain('Set the run window to see its summary, energy and steps.');
		expect(el.querySelectorAll('tr.step')).toHaveLength(0);
	});

	it('shows the processing error of a run that failed', async () => {
		await mount(data({ run: run({ status: 'error', error_message: 'The log has no Timestamp column.' }) }));
		expect(text()).toContain('Could not be processed');
		expect(text()).toContain('The log has no Timestamp column.');
	});
});

describe('summary', () => {
	it('shows the values with their units, and times as UK clock times', async () => {
		await mount(data());
		expect(text()).toContain('13:38:20'); // the first step's start
		expect(text()).toContain('13:45:00');
		expect(text()).toContain('7.67 kWh');
		expect(text()).toContain('30.70 kW');
		expect(text()).toContain('450.2 °C');
		expect(text()).toContain('25.5 %');
		expect(text()).toContain('0:11:40'); // extruding time, 700 s
	});

	it('names an energy part the log has no channel for', async () => {
		await mount(data({ run: run({ summary: summary({ missing: ['ips'], energy_kwh: { motor: 7, ips: null, cooling: 0.37, total: 7.37 } }) }) }));
		expect(text()).toContain('no IPS coil channel');
		expect(text()).not.toContain('IPS 0.30');
	});

	it('shows the whole log totals beside the run', async () => {
		await mount(data());
		expect(text()).toContain('Whole log');
		expect(text()).toContain('44.57 kWh');
		expect(text()).toContain('45.52 kWh');
		expect(text()).toContain('22.80 kW');
		expect(text()).toContain('1:59:59');
	});
});

describe('steps', () => {
	it('has one row per step, with the setpoint and ranges', async () => {
		await mount(data());
		const rows = el.querySelectorAll('tr.step');
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain('250 °C');
		expect(rows[1].textContent).toContain('8 rpm');
		expect(rows[1].textContent).toContain('430.0–480.0 (50.0)');
	});

	it('copies the steps as CSV', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await mount(data());
		button('Copy as CSV')!.click();
		await settle();
		expect(writeText).toHaveBeenCalledWith(stepsToCsv(STEPS));
		expect(button('Copied')).toBeTruthy();
	});

	it('has no copy button when there are no steps', async () => {
		await mount(data({ run: run({ steps: [] }) }));
		expect(button('Copy as CSV')).toBeUndefined();
		expect(text()).toContain('No step of a minute or more');
	});
});

describe('the run window', () => {
	const inputs = () => [...el.querySelectorAll<HTMLInputElement>('input[type=datetime-local]')];

	it('starts with the stored window as UK clock times, and cannot be saved until it changes', async () => {
		await mount(data({ run: run({ window_start: '2025-07-01T12:38:20Z', window_end: '2025-07-01T12:53:19Z' }) }));
		expect(inputs().map((i) => i.value)).toEqual(['2025-07-01T13:38:20', '2025-07-01T13:53:19']);
		expect(button('Set run window')!.disabled).toBe(true);
	});

	it('editing the start or end saves it through setRunWindow, as instants', async () => {
		vi.mocked(setRunWindow).mockResolvedValue(run());
		await mount(data());
		await type(inputs()[0], '2025-03-17T13:40:00');
		expect(button('Set run window')!.disabled).toBe(false);
		button('Set run window')!.click();
		await settle();
		expect(setRunWindow).toHaveBeenCalledWith(expect.anything(), OP, '2025-03-17T13:40:00.000Z', '2025-03-17T13:53:19.000Z');
		expect(changed).toBe(1);
	});

	it('shows the database refusal as it says it, and leaves the page as it was', async () => {
		vi.mocked(setRunWindow).mockRejectedValue(new ConformLogError('run window overlaps 17-03-25-CF-011'));
		await mount(data());
		await type(inputs()[1], '2025-03-17T14:30:00');
		button('Set run window')!.click();
		await settle();
		expect(el.querySelector('[role=alert]')?.textContent).toBe('run window overlaps 17-03-25-CF-011');
		expect(changed).toBe(0);
	});

	it('refuses a time that is not a clock time without calling the helper', async () => {
		await mount(data());
		await type(inputs()[0], '');
		button('Set run window')!.click();
		await settle();
		expect(setRunWindow).not.toHaveBeenCalled();
		expect(el.querySelector('[role=alert]')?.textContent).toContain('UK clock times');
	});

	it('is read-only for a reader who cannot change the run', async () => {
		await mount(data(), { canEdit: false });
		expect(inputs()).toHaveLength(0);
		expect(text()).toContain('Run window 13:38:20 – 13:53:19');
		expect(button('Set run window')).toBeUndefined();
	});
});

describe('a log this reader cannot see', () => {
	it('says so in place of the log, and still shows the run summary and steps', async () => {
		await mount(data({ log: null, logHidden: true }));
		expect(text()).toContain('Conform log not visible to you');
		expect(text()).toContain('7.67 kWh');
		expect(el.querySelectorAll('tr.step')).toHaveLength(2);
		expect(text()).toContain('13:38:20 – 13:53:19');
		expect(text()).not.toContain('Whole log');
		expect(el.querySelector('input[type=datetime-local]')).toBeNull();
	});
});

describe('where the log comes from', () => {
	it('offers an upload and "Use a log already uploaded" when the run does not exist yet', async () => {
		await mount({ run: null, log: null, logHidden: false });
		expect(text()).toContain('No Conform log yet');
		expect(el.querySelector('input[type=file]')).toBeTruthy();
		expect(button('Use a log already uploaded')).toBeTruthy();
	});

	it('offers the same for a run whose status is no_log', async () => {
		await mount({ run: run({ status: 'no_log', log_id: null, window_start: null, window_end: null, summary: null, steps: null }), log: null, logHidden: false });
		expect(el.querySelector('input[type=file]')).toBeTruthy();
		expect(button('Use a log already uploaded')).toBeTruthy();
	});

	it('offers neither once a log is linked', async () => {
		await mount(data());
		expect(el.querySelector('input[type=file]')).toBeNull();
		expect(button('Use a log already uploaded')).toBeUndefined();
	});

	it('offers neither to a reader who cannot change the run', async () => {
		await mount({ run: null, log: null, logHidden: false }, { canEdit: false });
		expect(el.querySelector('input[type=file]')).toBeNull();
		expect(text()).toContain('No Conform log has been uploaded for this run.');
	});

	it('uploads the chosen file with the run\'s machine and date, and shows the date warning', async () => {
		vi.mocked(uploadConformLog).mockResolvedValue({ run: run(), log: LOG, dateWarning: 'The log starts on 2025-03-20, more than a day from the run\'s date 2025-03-17; the date was not changed.' });
		await mount({ run: null, log: null, logHidden: false });
		const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
		const file = new File(['Timestamp,Wheel Speed (rpm)\n'], 'TiSwarf.csv', { type: 'text/csv' });
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(uploadConformLog).toHaveBeenCalledWith(
			expect.anything(),
			{ operation_id: OP, equipment_id: 'e1', operation_date: '2025-03-17T00:00:00Z' },
			{ name: 'TiSwarf.csv', text: 'Timestamp,Wheel Speed (rpm)\n' },
		);
		expect(changed).toBe(1);
	});

	it('shows a refused file as the helper words it, and changes nothing', async () => {
		vi.mocked(uploadConformLog).mockRejectedValue(new ConformLogError('The file has no Timestamp column.'));
		await mount({ run: null, log: null, logHidden: false });
		const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { value: [new File(['x'], 'bad.csv')], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(el.querySelector('[role=alert]')?.textContent).toBe('The file has no Timestamp column.');
		expect(changed).toBe(0);
	});

	it('lists the logs near the run\'s date from its machine, and links the one chosen', async () => {
		vi.mocked(listCandidateLogs).mockResolvedValue([LOG, { ...LOG, log_id: 'l2', source_filename: 'Other.csv' }]);
		vi.mocked(linkExistingLog).mockResolvedValue(run({ status: 'no_window' }));
		await mount({ run: null, log: null, logHidden: false });
		button('Use a log already uploaded')!.click();
		await settle();
		expect(listCandidateLogs).toHaveBeenCalledWith(expect.anything(), 'e1', '2025-03-17T00:00:00Z');
		const select = el.querySelector<HTMLSelectElement>('select')!;
		expect([...select.options].map((o) => o.textContent)).toEqual(['TiSwarf.csv · 2025-03-17 13:00:00', 'Other.csv · 2025-03-17 13:00:00']);
		select.value = 'l2';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await nextTick();
		button('Use this log')!.click();
		await settle();
		expect(linkExistingLog).toHaveBeenCalledWith(expect.anything(), OP, 'l2');
		expect(changed).toBe(1);
	});

	it('says when no log is near', async () => {
		vi.mocked(listCandidateLogs).mockResolvedValue([]);
		await mount({ run: null, log: null, logHidden: false });
		button('Use a log already uploaded')!.click();
		await settle();
		expect(text()).toContain('No Conform log from this machine starts within a day of this run\'s date.');
	});
});

describe('Recompute', () => {
	it('is offered when the summary has no version', async () => {
		await mount(data({ run: run({ summary: { ...summary(), version: undefined as never } }) }));
		expect(button('Recompute')).toBeTruthy();
	});

	it('is offered when the log was processed with older power constants', async () => {
		await mount(data({ log: { ...LOG, constants: { ...CONFORM_POWER_CONSTANTS, version: CONFORM_POWER_CONSTANTS.version - 1 } } }));
		expect(button('Recompute')).toBeTruthy();
	});

	it('is not offered when the run is up to date', async () => {
		await mount(data());
		expect(button('Recompute')).toBeUndefined();
	});

	it('is not offered without a window or a readable log: there is nothing to recompute', async () => {
		await mount(data({ run: run({ status: 'no_window', window_start: null, window_end: null, summary: null, steps: null }) }));
		expect(button('Recompute')).toBeUndefined();
	});

	it('recomputes through recomputeRun and asks the page to read again', async () => {
		vi.mocked(recomputeRun).mockResolvedValue(run());
		await mount(data({ log: { ...LOG, constants: { ...CONFORM_POWER_CONSTANTS, version: 0 } } }));
		button('Recompute')!.click();
		await settle();
		expect(recomputeRun).toHaveBeenCalledWith(expect.anything(), OP);
		expect(changed).toBe(1);
	});
});

describe('Open in Conform plotter', () => {
	it('is offered once a log is linked, and not before', async () => {
		await mount(data());
		expect(text()).toContain('Open in Conform plotter');
		app?.unmount();
		document.body.innerHTML = '';
		await mount({ run: null, log: null, logHidden: false });
		expect(text()).not.toContain('Open in Conform plotter');
	});
});
