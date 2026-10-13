import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editMessage } from '@d1/ui';
import { createEditor, READY_TIMEOUT_MS } from './editor';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const STAR = 'https://starbase.tail54eeb6.ts.net';

function setup(tab: object | null = { name: 'tab' }) {
	let focus: (() => void) | null = null;
	const openTab = vi.fn(() => tab as Window | null);
	const editor = createEditor({ serverBase: D1, openTab, onWindowFocus: (cb) => ((focus = cb), () => (focus = null)) });
	const frame = { name: 'frame' };
	editor.attachFrame(() => frame);
	return { editor, frame, openTab, focus: () => focus?.() };
}
const from = (source: unknown, data: unknown, origin = D1) => ({ origin, source, data });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the edit dialog', () => {
	it('opens the frame on the record, and a saved message closes it with "saved"', async () => {
		const { editor, frame } = setup();
		const done = editor.open('physical_samples', 'a/b');
		expect(editor.state.phase).toBe('loading');
		expect(editor.state.url).toBe(`${D1}/admin/d1-edit/physical_samples/a%2Fb`);
		editor.onMessage(from(frame, editMessage('ready', 'physical_samples', 'a/b')));
		expect(editor.state.phase).toBe('ready');
		editor.onMessage(from(frame, editMessage('saved', 'physical_samples', 'a/b')));
		await expect(done).resolves.toBe('saved');
		expect(editor.state.phase).toBe('closed');
	});

	it('cancel in the frame, or closing the dialog, is "cancelled"', async () => {
		const { editor, frame } = setup();
		const a = editor.open('projects', 'p1');
		editor.onMessage(from(frame, editMessage('cancelled', 'projects', 'p1')));
		await expect(a).resolves.toBe('cancelled');
		const b = editor.open('projects', 'p1');
		editor.close();
		await expect(b).resolves.toBe('cancelled');
	});

	it('no ready message in time: offer a new tab; coming back to STARbase counts as saved (Review Focus 3)', async () => {
		const { editor, openTab, focus } = setup();
		const done = editor.open('physical_samples', 's1');
		vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
		expect(editor.state.phase).toBe('loading');
		vi.advanceTimersByTime(1);
		expect(editor.state.phase).toBe('refused');
		editor.openInTab();
		expect(openTab).toHaveBeenCalledWith(editor.state.url);
		expect(editor.state.phase).toBe('tab');
		focus();
		await expect(done).resolves.toBe('saved');
	});

	it('the tab itself can answer, and Done closes too', async () => {
		const tab = { name: 'tab' };
		const { editor } = setup(tab);
		const a = editor.open('physical_samples', 's1');
		editor.openInTab();
		editor.onMessage(from(tab, editMessage('cancelled', 'physical_samples', 's1')));
		await expect(a).resolves.toBe('cancelled');
		const b = editor.open('physical_samples', 's1');
		editor.openInTab();
		editor.done();
		await expect(b).resolves.toBe('saved');
	});

	it('a blocked pop-up says so and keeps the dialog open', () => {
		const { editor } = setup(null);
		void editor.open('physical_samples', 's1');
		vi.advanceTimersByTime(READY_TIMEOUT_MS);
		editor.openInTab();
		expect(editor.state.phase).toBe('refused');
		expect(editor.state.blocked).toBe(true);
	});

	it('a late ready after the offer still shows the form', () => {
		const { editor, frame } = setup();
		void editor.open('physical_samples', 's1');
		vi.advanceTimersByTime(READY_TIMEOUT_MS);
		editor.onMessage(from(frame, editMessage('ready', 'physical_samples', 's1')));
		expect(editor.state.phase).toBe('ready');
	});

	it('ignores stray and forged messages (Review Focus 4)', () => {
		const { editor, frame } = setup();
		void editor.open('physical_samples', 's1');
		editor.onMessage(from(frame, editMessage('saved', 'physical_samples', 's1'), STAR));
		editor.onMessage(from({ name: 'another window' }, editMessage('saved', 'physical_samples', 's1')));
		editor.onMessage(from(frame, editMessage('saved', 'physical_samples', 's2')));
		editor.onMessage(from(frame, { type: 'd1-edit', result: 'saved' }));
		expect(editor.state.phase).toBe('loading');
	});

	it('a second Edit replaces the first, which resolves "cancelled"', async () => {
		const { editor } = setup();
		const first = editor.open('physical_samples', 's1');
		void editor.open('physical_samples', 's2');
		await expect(first).resolves.toBe('cancelled');
		expect(editor.state.id).toBe('s2');
	});
});
