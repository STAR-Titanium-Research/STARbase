import { describe, expect, it } from 'vitest';
import { confirmAction, confirmState, promptAction, resolveActive, setPromptValue } from './confirm';

/** Drain the microtask queue so a pending confirmAction() has actually reached `confirmState`. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('confirmAction', () => {
	it('resolves true only on an explicit accept', async () => {
		const p = confirmAction({ title: 'T', message: 'M' });
		await settle();
		expect(confirmState.current?.title).toBe('T');
		resolveActive(true);
		expect(await p).toBe(true);
		expect(confirmState.current).toBeNull();
	});

	it('resolves false on cancel', async () => {
		const p = confirmAction({ title: 'T', message: 'M' });
		await settle();
		resolveActive(false);
		expect(await p).toBe(false);
	});

	it('queues a second request instead of stranding its promise', async () => {
		// Two dialogs at once would stack, hiding one behind the other; whichever lost would never
		// be resolved and its caller would await forever. They must run strictly in order.
		const first = confirmAction({ title: 'first', message: 'M' });
		const second = confirmAction({ title: 'second', message: 'M' });
		await settle();

		expect(confirmState.current?.title).toBe('first');
		resolveActive(true);
		expect(await first).toBe(true);

		await settle(); // the next one is shown on a fresh task, not synchronously
		expect(confirmState.current?.title).toBe('second');
		resolveActive(false);
		expect(await second).toBe(false);
		expect(confirmState.current).toBeNull();
	});

	it('carries stats and labels through to the dialog', async () => {
		const p = confirmAction({
			title: 'Silence this alarm?',
			message: 'M',
			stats: [{ label: 'Fz force', value: '412.0 N (limit 400.0 N)' }],
			confirmLabel: 'Silence',
			tone: 'danger',
		});
		await settle();
		const cur = confirmState.current;
		expect(cur?.kind === 'confirm' && cur.stats?.[0].value).toBe('412.0 N (limit 400.0 N)');
		expect(confirmState.current?.confirmLabel).toBe('Silence');
		expect(confirmState.current?.tone).toBe('danger');
		resolveActive(false);
		await p;
	});
});

describe('promptAction', () => {
	it('resolves the entered text on confirm', async () => {
		// The regression this whole thing exists for: window.prompt() throws
		// "prompt() is not supported." under Electron, so NidaqPage.vue's "New Aux channel" and
		// "Virtual" buttons silently did nothing. This is the working replacement.
		const p = promptAction({ title: 'Name?', defaultValue: 'Aux' });
		await settle();
		expect(confirmState.current?.kind).toBe('prompt');
		expect(confirmState.promptValue).toBe('Aux'); // seeded from defaultValue
		setPromptValue('Temp1');
		resolveActive('Temp1');
		expect(await p).toBe('Temp1');
	});

	it('resolves null on cancel, mirroring window.prompt()', async () => {
		const p = promptAction({ title: 'Name?' });
		await settle();
		resolveActive(null);
		expect(await p).toBeNull();
	});

	it('keeps the dialog open and shows an error when validate rejects the value', async () => {
		const p = promptAction({
			title: 'Name?',
			validate: (v) => (v.trim() ? undefined : 'A name is required.'),
		});
		await settle();
		setPromptValue('');
		resolveActive(''); // attempt to confirm an empty name
		expect(confirmState.current).not.toBeNull(); // still open
		expect(confirmState.promptError).toBe('A name is required.');

		setPromptValue('Aux');
		resolveActive('Aux');
		expect(await p).toBe('Aux');
	});

	it('queues behind an in-progress confirm dialog, same as two confirms would', async () => {
		const confirmP = confirmAction({ title: 'first', message: 'M' });
		const promptP = promptAction({ title: 'second' });
		await settle();

		expect(confirmState.current?.title).toBe('first');
		resolveActive(true);
		expect(await confirmP).toBe(true);

		await settle();
		expect(confirmState.current?.kind).toBe('prompt');
		expect(confirmState.current?.title).toBe('second');
		resolveActive('value');
		expect(await promptP).toBe('value');
	});
});
