// @vitest-environment happy-dom
// From database…: the list reads on open, narrows as you type, greys what cannot be attached with its reason, picks by click and Enter, pages with
// Show more, and says plainly when nothing matches or the read failed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import AttachPicker from './AttachPicker.vue';
import type { OrphanRow } from './attachModel';

let app: App | null = null;
const row = (id: string, over: Partial<OrphanRow> = {}): OrphanRow => ({ id, version: 1, code: `CODE-${id}`, method: 'Turning', date: '2026-10-01', workState: 'planned', owner: 'Ada', output: { id: `s-${id}`, code: `S-${id}` }, ...over });

function mount(props: { search?: (q: string, offset: number) => Promise<{ rows: OrphanRow[]; more: boolean }>; reasonOf?: (r: OrphanRow) => string | null; problem?: string; onPick?: (r: OrphanRow) => void; onClose?: () => void }) {
	app = createApp({
		render: () =>
			h(AttachPicker as never, {
				heading: 'Attach to PS-001',
				search: props.search ?? (async () => ({ rows: [], more: false })),
				reasonOf: props.reasonOf ?? (() => null),
				problem: props.problem,
				onPick: props.onPick,
				onClose: props.onClose,
			}),
	});
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	return el;
}
const settle = async () => {
	for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
	await nextTick();
};
afterEach(() => {
	app?.unmount();
	app = null;
	vi.useRealTimers();
	document.body.innerHTML = '';
});
const options = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="option"]')];

describe('the From database picker', () => {
	it('is a dialog that reads the first page on open and shows code, method, state, day, owner and the sample made', async () => {
		const search = vi.fn(async () => ({ rows: [row('a'), row('b', { workState: 'done', owner: null, output: null, date: null })], more: false }));
		const el = mount({ search });
		await settle();
		expect(search).toHaveBeenCalledWith('', 0);
		expect(el.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
		expect(el.textContent).toContain('Attach to PS-001');
		const [a, b] = options(el);
		expect(a.textContent).toContain('CODE-a');
		expect(a.textContent).toContain('Turning');
		expect(a.textContent).toContain('Planned');
		expect(a.textContent).toContain('2026-10-01 · Ada · makes S-a');
		expect(b.textContent).toContain('Done');
		expect(b.textContent).toContain('no date');
		expect(document.activeElement).toBe(el.querySelector('input'));
		expect(options(el)[0].getAttribute('aria-selected')).toBe('true');
	});

	it('a click picks; a greyed row cannot be picked and says why', async () => {
		const onPick = vi.fn();
		const el = mount({ search: async () => ({ rows: [row('a'), row('b')], more: false }), reasonOf: (r) => (r.id === 'b' ? 'Already on the canvas.' : null), onPick });
		await settle();
		const [a, b] = options(el);
		expect(b.getAttribute('aria-disabled')).toBe('true');
		expect(b.textContent).toContain('Already on the canvas.');
		b.click();
		expect(onPick).not.toHaveBeenCalled();
		a.click();
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
	});

	it('Enter picks the highlighted row, ArrowDown skips a greyed one, Esc closes', async () => {
		const onPick = vi.fn();
		const onClose = vi.fn();
		const el = mount({ search: async () => ({ rows: [row('a'), row('b'), row('c')], more: false }), reasonOf: (r) => (r.id === 'b' ? 'Already on the canvas.' : null), onPick, onClose });
		await settle();
		const dialog = el.querySelector<HTMLElement>('[role="dialog"]')!;
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await nextTick();
		expect(options(el)[2].getAttribute('aria-selected')).toBe('true');
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onClose).toHaveBeenCalled();
	});

	it('Enter on the Show more or Close button is that button\'s own, not a pick of the highlighted row', async () => {
		const onPick = vi.fn();
		const onClose = vi.fn();
		const el = mount({ search: async () => ({ rows: [row('a'), row('b')], more: true }), onPick, onClose });
		await settle();
		el.querySelector<HTMLElement>('.more')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		el.querySelector<HTMLElement>('.x')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		expect(onPick).not.toHaveBeenCalled();
		// ... while Enter in the search box still picks
		el.querySelector<HTMLElement>('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
	});

	it('asks again for what is typed, a moment after the last key, from the first page', async () => {
		vi.useFakeTimers();
		const search = vi.fn(async (q: string) => ({ rows: q ? [row('z')] : [row('a')], more: false }));
		const el = mount({ search });
		await vi.advanceTimersByTimeAsync(0);
		const input = el.querySelector<HTMLInputElement>('input')!;
		input.value = 'turn';
		input.dispatchEvent(new Event('input'));
		await vi.advanceTimersByTimeAsync(100);
		expect(search).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(150);
		expect(search).toHaveBeenLastCalledWith('turn', 0);
		await nextTick();
		expect(options(el).map((o) => o.getAttribute('data-operation'))).toEqual(['z']);
	});

	it('Show more reads the next page and adds it below', async () => {
		const search = vi.fn(async (_q: string, offset: number) => (offset ? { rows: [row('c')], more: false } : { rows: [row('a'), row('b')], more: true }));
		const el = mount({ search });
		await settle();
		el.querySelector<HTMLButtonElement>('.more')!.click();
		await settle();
		expect(search).toHaveBeenLastCalledWith('', 2);
		expect(options(el).map((o) => o.getAttribute('data-operation'))).toEqual(['a', 'b', 'c']);
		expect(el.querySelector('.more')).toBeNull();
	});

	it('Show more keeps the highlighted row and the focus in the dialog (the button is aria-disabled while it reads, and gone with the last page), and lists a repeated row once', async () => {
		let release: () => void = () => undefined;
		const search = vi.fn((_q: string, offset: number) =>
			offset
				? new Promise<{ rows: OrphanRow[]; more: boolean }>((r) => void (release = () => r({ rows: [row('b'), row('c')], more: false })))
				: Promise.resolve({ rows: [row('a'), row('b')], more: true }),
		);
		const el = mount({ search });
		await settle();
		const dialog = el.querySelector<HTMLElement>('[role="dialog"]')!;
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await nextTick();
		expect(options(el)[1].getAttribute('aria-selected')).toBe('true');
		const more = el.querySelector<HTMLButtonElement>('.more')!;
		more.focus();
		more.click();
		await nextTick();
		expect(more.disabled, 'not disabled: a disabled button drops the focus').toBe(false);
		expect(more.getAttribute('aria-disabled')).toBe('true');
		release();
		await settle();
		expect(options(el).map((o) => o.getAttribute('data-operation')), 'b is not listed twice').toEqual(['a', 'b', 'c']);
		expect(options(el)[1].getAttribute('aria-selected'), 'the highlight stayed').toBe('true');
		expect(el.querySelector('.more')).toBeNull();
		expect(document.activeElement, 'focus is on the search box, not the page').toBe(el.querySelector('input'));
		dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await nextTick();
		expect(options(el)[2].getAttribute('aria-selected'), 'the dialog\'s keys still work').toBe('true');
	});

	it('says so when nothing matches, when the list cannot be read, and what went wrong with a pick', async () => {
		const el = mount({ search: async () => ({ rows: [], more: false }) });
		await settle();
		expect(el.querySelector('[role="status"]')?.textContent).toContain('No operation without an input sample');
		app?.unmount();
		document.body.innerHTML = '';
		const bad = mount({ search: async () => Promise.reject(new Error('x')) });
		await settle();
		expect(bad.querySelector('[role="status"]')?.textContent).toContain('could not be read');
		expect(bad.querySelector('[role="status"]')?.classList.contains('bad')).toBe(true);
		app?.unmount();
		document.body.innerHTML = '';
		const picked = mount({ search: async () => ({ rows: [row('a')], more: false }), problem: 'It got an input in the meantime, so it cannot be attached any more.' });
		await settle();
		expect(picked.querySelector('[role="status"]')?.textContent).toContain('got an input in the meantime');
	});
});
