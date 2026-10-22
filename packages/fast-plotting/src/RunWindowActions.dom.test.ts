// @vitest-environment happy-dom
// The run actions of the Conform plotter in a DOM: semantics (a list of buttons, not buttons made list items), the two inline
// confirms (group, live region, focus to Cancel and back), the "already uploaded" prompt with the windows on that log, the
// logs on offer going stale after an action, refusals worded as plain sentences, and the view in clock time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import RunWindowActions from './RunWindowActions.vue';
import { ConformLogError } from './conform';
import { resetFastHost, setFastHost, type FastHost } from './host';
import type { Trace } from './fastCache';
import type { LinkCandidate, RunProfile } from './profile';

const flush = async () => { for (let i = 0; i < 6; i++) { await nextTick(); await Promise.resolve(); } };
const trace: Trace = { time: Float64Array.from([0, 1, 2, 3, 4]), n: 5, series: {}, order: [] };
const T0 = Date.parse('2025-03-17T09:00:00Z');   // UK time is GMT on that day

let app: App | null = null;
let host: HTMLElement;
beforeEach(() => {
	setFastHost({ api: {} as FastHost['api'], openRecord: () => {} });
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => { app?.unmount(); app = null; host.remove(); resetFastHost(); });

const CANDIDATES: LinkCandidate[] = [{ id: 'l1', label: 'run.csv · 17 Mar 2025, 09:00:00', windows: ['Ti swarf: 09:10:00 – 09:20:00'], note: null }];
function fakeProfile(over: Partial<RunProfile> = {}): RunProfile & { calls: string[] } {
	const calls: string[] = [];
	const profile = {
		hasLog: (r: unknown) => !!(r as { log?: unknown }).log,
		windowLabel: () => '09:10:00 – 09:20:00 on 17 Mar 2025 (UK time)',
		startMs: () => T0,
		setWindowFromView: vi.fn(async () => { calls.push('window'); }),
		upload: vi.fn(async () => ({ warning: null })),
		unlink: vi.fn(async () => { calls.push('unlink'); }),
		linkExisting: {
			list: vi.fn(async () => { calls.push('list'); return CANDIDATES; }),
			emptyText: () => 'No log.',
			link: vi.fn(async () => { calls.push('link'); }),
		},
		calls,
		...over,
	} as unknown as RunProfile & { calls: string[] };
	return profile;
}

function mount(profile: RunProfile, runData: unknown, props: Record<string, unknown> = {}) {
	const changed = vi.fn();
	app = createApp(defineComponent({
		render: () => h(RunWindowActions as any, {
			profile, detail: { operation_id: 'op-1' }, runData, trace, zoomStart: 62.4, zoomEnd: 123.6, busy: false, canEdit: true, onChanged: changed, ...props,
		}),
	}));
	app.component('v-progress-circular', defineComponent({ render: () => h('span') }));
	app.mount(host);
	return { changed };
}
const byText = (text: string) => [...host.querySelectorAll<HTMLElement>('button, label')].find((b) => b.textContent?.trim().startsWith(text))!;

describe('RunWindowActions semantics', () => {
	it('keeps the buttons as buttons: the picker is a list of buttons, none is itself a list item', async () => {
		mount(fakeProfile(), { log: null });
		byText('Use a log already uploaded').click();
		await flush();
		const list = host.querySelector('ul.pick')!;
		expect(list.getAttribute('aria-label')).toBe('Logs already uploaded');
		const items = [...list.querySelectorAll('li')];
		expect(items).toHaveLength(1);
		expect(items[0].querySelector('button')).not.toBeNull();
		expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(0);
		expect(items[0].textContent).toContain('Ti swarf: 09:10:00 – 09:20:00');
	});

	it('words the view in UK clock times, as the saved window above it', () => {
		mount(fakeProfile(), { log: {} });
		expect(byText('Use this view as the run window').textContent).toContain('09:01:02 – 09:02:04');
	});
});

describe('the inline confirms', () => {
	it('opens Unlink as a group in a polite live region, with Cancel focused, and gives the focus back on Cancel', async () => {
		mount(fakeProfile(), { log: {} });
		const unlinkOpen = byText('Unlink log');
		unlinkOpen.focus();
		unlinkOpen.click();
		await flush();
		const group = host.querySelector('[role="group"]')!;
		expect(group.getAttribute('aria-label')).toBe('Unlink the log');
		expect(group.closest('[aria-live="polite"]')).not.toBeNull();
		expect(document.activeElement?.textContent).toBe('Cancel');
		const danger = [...group.querySelectorAll('button')].find((b) => b.textContent === 'Unlink')!;
		expect(danger.classList.contains('danger')).toBe(true);
		(document.activeElement as HTMLElement).click();
		await flush();
		expect(host.querySelector('[role="group"]')).toBeNull();
		expect(document.activeElement).toBe(unlinkOpen);
	});

	it('names Replace by its own action', async () => {
		mount(fakeProfile(), { log: {} });
		byText('Replace log').click();
		await flush();
		const group = host.querySelector('[role="group"]')!;
		expect(group.getAttribute('aria-label')).toBe('Replace the log');
		expect(group.textContent).toContain('Unlink and replace');
	});

	it('shows the windows already on the log a file is already uploaded as, with the whole-log note, before "Use that log"', async () => {
		const profile = fakeProfile({
			upload: vi.fn(async () => ({
				warning: null,
				existing: { id: 'l9', label: 'old.csv · 17 Mar 2025, 09:00:00', windows: ['Ti swarf: 09:00:00 – 11:00:00'], note: "The whole log is Ti swarf's window: narrow that run's window first" },
			})),
		} as Partial<RunProfile>);
		mount(profile, { log: null });
		const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
		Object.defineProperty(input, 'files', { value: [new File(['x'], 'again.csv')], configurable: true });
		input.dispatchEvent(new Event('change'));
		await flush();
		const group = host.querySelector('[role="group"]')!;
		expect(group.getAttribute('aria-label')).toBe('This file is already uploaded');
		const text = group.textContent!;
		expect(text).toContain('already uploaded as old.csv · 17 Mar 2025, 09:00:00');
		expect(text).toContain('Ti swarf: 09:00:00 – 11:00:00');
		expect(text.indexOf("The whole log is Ti swarf's window")).toBeGreaterThan(-1);
		expect(text.indexOf("The whole log is Ti swarf's window")).toBeLessThan(text.indexOf('Use that log'));
		expect(document.activeElement?.textContent).toBe('Cancel');
	});
});

describe('the logs on offer', () => {
	it('are fetched again after an action, not kept from before it', async () => {
		const profile = fakeProfile();
		const { changed } = mount(profile, { log: null });
		byText('Use a log already uploaded').click();
		await flush();
		expect(profile.calls).toEqual(['list']);
		byText('Use a log already uploaded').click();   // closed again
		await flush();
		byText('Use this view as the run window').click();
		await flush();
		expect(profile.calls).toEqual(['list', 'window']);
		expect(changed).toHaveBeenCalledWith({ resetView: false });
		byText('Use a log already uploaded').click();   // opened again: the list is read again
		await flush();
		expect(profile.calls).toEqual(['list', 'window', 'list']);
	});
});

describe('refusals', () => {
	it('shows our own refusal as worded, and Directus developer text as a plain sentence', async () => {
		const profile = fakeProfile({ setWindowFromView: vi.fn(async () => { throw new ConformLogError('Run window overlaps 17-03-25-CF-011 on this log.'); }) } as Partial<RunProfile>);
		mount(profile, { log: {} });
		byText('Use this view as the run window').click();
		await flush();
		expect(host.querySelector('[role="alert"]')?.textContent).toBe('Run window overlaps 17-03-25-CF-011 on this log.');

		app?.unmount(); host.innerHTML = '';
		const stock = Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data: { errors: [{ message: "You don't have permission to access this.", extensions: { code: 'FORBIDDEN', reason: 'dev text' } }] } } });
		mount(fakeProfile({ unlink: vi.fn(async () => { throw stock; }) } as Partial<RunProfile>), { log: {} });
		byText('Unlink log').click();
		await flush();
		(host.querySelector('.danger') as HTMLElement).click();
		await flush();
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("You can't change this Conform run.");
	});
});
