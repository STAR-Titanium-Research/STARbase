// @vitest-environment happy-dom
// The Operation page's "Conform run" section, with the @d1/fast-plotting helpers that touch the network mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import {
	ConformLogError, ConformLogHiddenError, CONFORM_POWER_CONSTANTS, linkExistingLog, listCandidateLogs, loadLogTrace, recomputeRun, setRunWindow, stepsToCsv,
	unlinkLog, uploadConformLog,
	type CandidateLog, type ConformLogRow, type ConformRunBundle, type ConformRunRow, type ConformStep, type ConformSummary,
} from '@d1/fast-plotting';
import { setExplorerHostFactory } from '@d1/ui';
import ConformRunSection from './ConformRunSection.vue';

vi.mock('@d1/fast-plotting', async (orig) => ({
	...(await orig<typeof import('@d1/fast-plotting')>()),
	setRunWindow: vi.fn(),
	recomputeRun: vi.fn(),
	uploadConformLog: vi.fn(),
	listCandidateLogs: vi.fn(),
	linkExistingLog: vi.fn(),
	unlinkLog: vi.fn(),
	loadLogTrace: vi.fn(async () => {
		throw new Error('no trace in these tests');
	}),
}));

const OP = '00000000-0000-4000-8000-0000000000c1';

const summary = (over: Partial<ConformSummary> = {}): ConformSummary => ({
	version: 1, constants_version: CONFORM_POWER_CONSTANTS.version, duration_s: 899, n_rows: 900, gaps: 0, extruding_s: 700, mean_wheel_speed_rpm: 8, mean_torque_pct: 25.5, mean_tooling1_c: 450.2,
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
	duration_s: 7199, series: [], constants: { ...CONFORM_POWER_CONSTANTS }, source_sha256: 'abc', run_windows: [],
	totals: { duration_s: 7199, energy_kwh: { motor: 44.57, ips: 0.78, cooling: 0.17, total: 45.52 }, avg_demand_kw: 22.8, missing: [] },
};
const data = (over: Partial<ConformRunBundle> = {}): ConformRunBundle => ({ run: run(), log: LOG, logHidden: false, ...over });

let app: App | null = null;
let el: HTMLElement;
let changed = 0;

async function mount(d: ConformRunBundle | null, props: Record<string, unknown> = {}) {
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
		expect(text()).toContain('11 min 40 s'); // extruding time, 700 s
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
		expect(text()).toContain('1 h 59 min');
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
		expect(button('Set run window')!.getAttribute('aria-disabled')).toBe('true');
	});

	it('editing the start or end saves it through setRunWindow, as instants', async () => {
		vi.mocked(setRunWindow).mockResolvedValue(run());
		await mount(data());
		await type(inputs()[0], '2025-03-17T13:40:00');
		expect(button('Set run window')!.getAttribute('aria-disabled')).toBe('false');
		button('Set run window')!.click();
		await settle();
		expect(setRunWindow).toHaveBeenCalledWith(expect.anything(), OP, '2025-03-17T13:40:00.000Z', '2025-03-17T13:53:19.000Z');
		expect(changed).toBe(1);
	});

	it('shows the database refusal as it says it, and leaves the page as it was', async () => {
		vi.mocked(setRunWindow).mockRejectedValue(new ConformLogError('Run window overlaps 17-03-25-CF-011 on this log.'));
		await mount(data());
		await type(inputs()[1], '2025-03-17T14:30:00');
		button('Set run window')!.click();
		await settle();
		expect(el.querySelector('[role=alert]')?.textContent).toBe('Run window overlaps 17-03-25-CF-011 on this log.');
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

const cand = (l: ConformLogRow, windows: CandidateLog['windows'] = []): CandidateLog => ({ ...l, windows });

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
		const file = new File([new TextEncoder().encode('Timestamp,Wheel Speed (rpm)\n')], 'TiSwarf.csv', { type: 'text/csv' });
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(uploadConformLog).toHaveBeenCalledWith(
			expect.anything(),
			{ operation_id: OP, equipment_id: 'e1', operation_date: '2025-03-17T00:00:00Z', work_state: null },
			{ name: 'TiSwarf.csv', bytes: expect.any(ArrayBuffer) },
		);
		const sent = vi.mocked(uploadConformLog).mock.calls[0][2].bytes as ArrayBuffer;
		expect(new TextDecoder().decode(sent)).toBe('Timestamp,Wheel Speed (rpm)\n');   // the raw bytes, not decoded text
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
		vi.mocked(listCandidateLogs).mockResolvedValue([cand(LOG), cand({ ...LOG, log_id: 'l2', source_filename: 'Other.csv' })]);
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

	it('is offered when the summary has no constants_version, or a lower one', async () => {
		await mount(data({ run: run({ summary: { ...summary(), constants_version: undefined } }) }));
		expect(button('Recompute')).toBeTruthy();
		app?.unmount();
		document.body.innerHTML = '';
		await mount(data({ run: run({ summary: { ...summary(), constants_version: CONFORM_POWER_CONSTANTS.version - 1 } }) }));
		expect(button('Recompute')).toBeTruthy();
	});

	it('does not compare against the log row (members cannot update it)', async () => {
		await mount(data({ log: { ...LOG, constants: { ...CONFORM_POWER_CONSTANTS, version: 0 } } }));
		expect(button('Recompute')).toBeUndefined();
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
		await mount(data({ run: run({ summary: { ...summary(), constants_version: 0 } }) }));
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


describe('the run window keeps what the person did not edit', () => {
	const inputs = () => [...el.querySelectorAll<HTMLInputElement>('input[type=datetime-local]')];
	const FRAC = { window_start: '2025-03-17T13:38:20.250Z', window_end: '2025-03-17T13:53:19.750Z' };

	it('sends an untouched field as its stored instant, not truncated to the second', async () => {
		vi.mocked(setRunWindow).mockResolvedValue(run());
		await mount(data({ run: run(FRAC), log: { ...LOG, log_start: '2025-03-17T13:00:00Z' } }));
		await type(inputs()[1], '2025-03-17T13:50:00');   // edit the end only
		button('Set run window')!.click();
		await settle();
		expect(setRunWindow).toHaveBeenCalledWith(expect.anything(), OP, '2025-03-17T13:38:20.250Z', '2025-03-17T13:50:00.000Z');
	});

	it('clamps an edited value to the log and says so', async () => {
		vi.mocked(setRunWindow).mockResolvedValue(run());
		await mount(data());   // log 13:00:00 to 15:00:00
		await type(inputs()[1], '2025-03-17T16:00:00');
		button('Set run window')!.click();
		await settle();
		expect(setRunWindow).toHaveBeenCalledWith(expect.anything(), OP, '2025-03-17T13:38:20.000Z', '2025-03-17T15:00:00.000Z');
		expect(el.querySelector('[role=status]')?.textContent).toMatch(/end was after the log.*2025-03-17 15:00:00, UK time/);
	});

	it('stays mounted, with its focus, while the page reads the run again', async () => {
		vi.mocked(setRunWindow).mockResolvedValue(run());
		const state = ref<{ data: ConformRunBundle; loading: boolean; error: string }>({ data: data(), loading: false, error: '' });
		setExplorerHostFactory(() => ({ api: { get: vi.fn() } as never, navigate() {}, openDataStudio() {}, fieldsFor: async () => [] }) as never);
		app = createApp({ render: () => h(ConformRunSection, { operationId: OP, equipmentId: 'e1', state: state.value }) });
		for (const n of ['v-button', 'v-icon', 'v-progress-circular']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', { class: n }, slots.default?.()) }));
		el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await nextTick();
		await type(inputs()[0], '2025-03-17T13:40:00');
		const btn = button('Set run window')!;
		btn.focus();
		expect(document.activeElement).toBe(btn);
		state.value = { ...state.value, loading: true };   // the page starts reading again: the data stays
		await nextTick();
		expect(button('Set run window')).toBe(btn);        // the same element, not rebuilt
		expect(document.activeElement).toBe(btn);
		expect(text()).toContain('Updating…');
		state.value = { data: data({ run: run({ window_start: '2025-03-17T13:40:00Z' }) }), loading: false, error: '' };
		await nextTick();
		expect(button('Set run window')).toBe(btn);
	});

	it('focus stays on the button while it saves (it is aria-disabled, not disabled)', async () => {
		let release!: () => void;
		vi.mocked(setRunWindow).mockImplementation(() => new Promise((r) => { release = () => r(run()); }));
		await mount(data());
		await type(inputs()[0], '2025-03-17T13:40:00');
		const btn = button('Set run window')!;
		btn.focus();
		btn.click();
		await nextTick();
		expect(btn.hasAttribute('disabled')).toBe(false);
		expect(btn.getAttribute('aria-disabled')).toBe('true');
		expect(document.activeElement).toBe(btn);
		release();
		await settle();
	});
});

describe('unlink and replace', () => {
	it('asks first, then unlinks through unlinkLog and asks the page to read again', async () => {
		vi.mocked(unlinkLog).mockResolvedValue({ logRemoved: true });
		await mount(data());
		button('Unlink log')!.click();
		await nextTick();
		expect(unlinkLog).not.toHaveBeenCalled();
		expect(text()).toContain('This clears the run window, summary and steps.');
		button('Unlink')!.click();
		await settle();
		expect(unlinkLog).toHaveBeenCalledWith(expect.anything(), OP);
		expect(changed).toBe(1);
	});

	it('cancelling changes nothing', async () => {
		await mount(data());
		button('Unlink log')!.click();
		await nextTick();
		button('Cancel')!.click();
		await nextTick();
		expect(unlinkLog).not.toHaveBeenCalled();
		expect(text()).not.toContain('This clears the run window');
	});

	it('Replace log unlinks, and the chooser then opens by itself once the run has no log', async () => {
		vi.mocked(unlinkLog).mockResolvedValue({ logRemoved: false });
		vi.mocked(listCandidateLogs).mockResolvedValue([cand(LOG)]);
		const state = ref<{ data: ConformRunBundle; loading: boolean; error: string }>({ data: data(), loading: false, error: '' });
		setExplorerHostFactory(() => ({ api: { get: vi.fn() } as never, navigate() {}, openDataStudio() {}, fieldsFor: async () => [] }) as never);
		app = createApp({ render: () => h(ConformRunSection, { operationId: OP, equipmentId: 'e1', state: state.value, onChanged: () => changed++ }) });
		for (const n of ['v-button', 'v-icon', 'v-progress-circular']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', { class: n }, slots.default?.()) }));
		el = document.createElement('div');
		document.body.appendChild(el);
		changed = 0;
		app.mount(el);
		await nextTick();
		button('Replace log')!.click();
		await nextTick();
		button('Unlink and replace')!.click();
		await settle();
		expect(unlinkLog).toHaveBeenCalledOnce();
		expect(changed).toBe(1);
		expect(listCandidateLogs).not.toHaveBeenCalled();
		// the page reads the run again: it has no log now, and the picker is already open
		state.value = { data: { run: run({ status: 'no_log', log_id: null, window_start: null, window_end: null, summary: null, steps: null }), log: null, logHidden: false }, loading: false, error: '' };
		await settle();
		expect(listCandidateLogs).toHaveBeenCalledOnce();
		expect(el.querySelector('select')).toBeTruthy();
		expect(button('Use this log')).toBeTruthy();
	});

	it('a plain Unlink leaves the chooser closed', async () => {
		vi.mocked(unlinkLog).mockResolvedValue({ logRemoved: false });
		const state = ref<{ data: ConformRunBundle; loading: boolean; error: string }>({ data: data(), loading: false, error: '' });
		setExplorerHostFactory(() => ({ api: { get: vi.fn() } as never, navigate() {}, openDataStudio() {}, fieldsFor: async () => [] }) as never);
		app = createApp({ render: () => h(ConformRunSection, { operationId: OP, equipmentId: 'e1', state: state.value }) });
		for (const n of ['v-button', 'v-icon', 'v-progress-circular']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', { class: n }, slots.default?.()) }));
		el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await nextTick();
		button('Unlink log')!.click();
		await nextTick();
		button('Unlink')!.click();
		await settle();
		state.value = { data: { run: run({ status: 'no_log', log_id: null, window_start: null, window_end: null, summary: null, steps: null }), log: null, logHidden: false }, loading: false, error: '' };
		await settle();
		expect(listCandidateLogs).not.toHaveBeenCalled();
		expect(button('Use a log already uploaded')).toBeTruthy();
	});

	it('is offered to someone who can edit, also when the log is hidden, and to no one else', async () => {
		await mount(data({ log: null, logHidden: true }));
		expect(button('Unlink log')).toBeTruthy();
		app?.unmount();
		document.body.innerHTML = '';
		await mount(data(), { canEdit: false });
		expect(button('Unlink log')).toBeUndefined();
		expect(button('Replace log')).toBeUndefined();
		expect(button('Set run window')).toBeUndefined();
		expect(button('Recompute')).toBeUndefined();
	});

	it('shows a refusal as it is worded', async () => {
		vi.mocked(unlinkLog).mockRejectedValue(new ConformLogError('You do not have permission to access this.'));
		await mount(data());
		button('Unlink log')!.click();
		await nextTick();
		button('Unlink')!.click();
		await settle();
		expect(el.querySelector('[role=alert]')?.textContent).toBe('You do not have permission to access this.');
		expect(changed).toBe(0);
	});
});

describe('a file that is already uploaded', () => {
	it('offers that log instead of uploading, and links it when accepted', async () => {
		vi.mocked(uploadConformLog).mockResolvedValue({ existing: { ...LOG, source_filename: 'old.csv' } });
		vi.mocked(linkExistingLog).mockResolvedValue(run({ status: 'no_window' }));
		await mount({ run: null, log: null, logHidden: false });
		const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { value: [new File(['x'], 'again.csv')], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(text()).toContain('This file is already uploaded as old.csv · 2025-03-17 13:00:00');
		expect(changed).toBe(0);
		button('Use that log')!.click();
		await settle();
		expect(linkExistingLog).toHaveBeenCalledWith(expect.anything(), OP, 'l1');
		expect(changed).toBe(1);
	});
});

describe('the other runs on the log', () => {
	it('lists the other windows on the log with their times, and not this run\'s own', async () => {
		const W = [
			{ operation_id: OP, start: '2025-03-17T13:38:20Z', end: '2025-03-17T13:53:19Z' },
			{ operation_id: 'other-1', start: '2025-03-17T14:00:00Z', end: '2025-03-17T14:30:00Z' },
			{ operation_id: 'other-2', start: '2025-03-17T14:30:00Z', end: '2025-03-17T14:45:00Z' },
		];
		// the reader can see other-1 only (labelWindows reads the operations through the host's api)
		setExplorerHostFactory(() => ({
			api: { get: vi.fn(async () => ({ data: { data: [{ operation_id: 'other-1', pass_code: '17-03-25-CF-012', conform_feedstock: 'Ti swarf' }] } })) } as never,
			navigate() {}, openDataStudio() {}, fieldsFor: async () => [],
		}) as never);
		app = createApp({ render: () => h(ConformRunSection, { operationId: OP, state: { data: data({ log: { ...LOG, run_windows: W } }), loading: false, error: '' } }) });
		for (const n of ['v-button', 'v-icon', 'v-progress-circular']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', { class: n }, slots.default?.()) }));
		el = document.createElement('div');
		document.body.appendChild(el);
		app.mount(el);
		await settle();
		expect(text()).toContain('Other runs on this log');
		expect(text()).toContain('Ti swarf: 14:00:00 – 14:30:00');
		expect(text()).toContain('Other run: 14:30:00 – 14:45:00');
		expect(el.querySelectorAll('.others li')).toHaveLength(2);
	});
});

describe('planned runs and the picker wording', () => {
	it('passes the run state to the upload, so a planned run is not dated from the log', async () => {
		vi.mocked(uploadConformLog).mockResolvedValue({ run: run(), log: LOG, dateWarning: null });
		await mount({ run: null, log: null, logHidden: false }, { workState: 'planned', operationDate: null });
		const input = el.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.csv')], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(vi.mocked(uploadConformLog).mock.calls[0][1]).toMatchObject({ work_state: 'planned', operation_date: null });
	});

	it('searches around today with no run date, and says so when nothing is near', async () => {
		vi.mocked(listCandidateLogs).mockResolvedValue([]);
		await mount({ run: null, log: null, logHidden: false }, { operationDate: null });
		button('Use a log already uploaded')!.click();
		await settle();
		expect(listCandidateLogs).toHaveBeenCalledWith(expect.anything(), 'e1', null);
		expect(text()).toContain('within a day of today');
	});

	it('shows the windows already on the chosen log, and the whole-log note', async () => {
		const whole = { operation_id: 'o9', label: 'Ti swarf', readable: true, start: LOG.log_start, end: LOG.log_end };
		vi.mocked(listCandidateLogs).mockResolvedValue([cand(LOG, [whole])]);
		await mount({ run: null, log: null, logHidden: false });
		button('Use a log already uploaded')!.click();
		await settle();
		expect(el.querySelector('.wins')?.textContent).toContain('Ti swarf: 13:00:00 – 15:00:00');
		expect(text()).toContain("The whole log is Ti swarf's window: narrow that run's window first");
	});
});

describe('a log file this reader may not read', () => {
	it('says so in place of the trace when the file is forbidden', async () => {
		vi.mocked(loadLogTrace).mockRejectedValueOnce(new ConformLogHiddenError());
		await mount(data());
		await settle();
		expect(text()).toContain('Conform log not visible to you');
		expect(text()).toContain('7.67 kWh');   // the run's own summary still shows
	});

	it('says it could not load the log for any other failure', async () => {
		await mount(data());   // the default mock rejects with a plain Error
		await settle();
		expect(text()).toContain('Could not load the Conform log');
		expect(text()).not.toContain('not visible');
	});
});
