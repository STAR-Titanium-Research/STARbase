// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import KindPicker from './KindPicker.vue';
import type { MethodEntry, TestTypeEntry } from './catalog';

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = '';
});

const methods: MethodEntry[] = [
	{ id: 'm-fast', name: 'FAST', code: 'FAST', category: 'sintering' },
	{ id: 'm-mill', name: 'Milling', code: 'MIL', category: 'machining' },
	{ id: 'm-turn', name: 'Turning', code: 'TUR', category: 'machining' },
	{ id: 'm-odd', name: 'Etching', code: 'ETC', category: null },
];
const testTypes: TestTypeEntry[] = [
	{ value: 'tensile', name: 'Destructive — Tensile' },
	{ value: 'hardness', name: 'Non-destructive — Hardness' },
	{ value: 'fatigue', name: 'Dynamic — Fatigue' },
	{ value: 'misc', name: 'Weighing' },
];

function mount(props: { kind: 'operation' | 'test'; value?: string | null; testTypes?: TestTypeEntry[] }, onChoose = vi.fn()) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	app = createApp(KindPicker, { value: null, methods, testTypes, ...props, onChoose });
	app.mount(el);
	return { el, select: el.querySelector('select') as HTMLSelectElement, onChoose };
}
const groups = (select: HTMLSelectElement) => [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)] as const);

describe('KindPicker: an operation', () => {
	it('is a nodrag select that the add focus can find, with a placeholder first', () => {
		const { select } = mount({ kind: 'operation' });
		expect(select.hasAttribute('data-kind-select')).toBe(true);
		expect(select.getAttribute('aria-label')).toBe('Kind of operation');
		expect(select.classList.contains('nodrag') && select.classList.contains('nopan')).toBe(true);
		expect(select.options[0].textContent).toBe('Choose the kind…');
		expect(select.value).toBe('');
	});

	it('groups the methods by process category in the catalog order, the rest under Other', () => {
		const { select } = mount({ kind: 'operation' });
		expect(groups(select)).toEqual([
			['Machining', ['Milling', 'Turning']],
			['FAST sintering', ['FAST']],
			['Other', ['Etching']],
		]);
	});

	it('shows the chosen method', () => {
		expect(mount({ kind: 'operation', value: 'm-turn' }).select.value).toBe('m-turn');
	});

	it('emits the method and its category when one is chosen', async () => {
		const { select, onChoose } = mount({ kind: 'operation' });
		select.value = 'm-fast';
		select.dispatchEvent(new Event('change'));
		await nextTick();
		expect(onChoose).toHaveBeenCalledWith({ methodId: 'm-fast', category: 'sintering' });
	});

	it('says nothing when the placeholder is chosen again', async () => {
		const { select, onChoose } = mount({ kind: 'operation', value: 'm-turn' });
		select.value = '';
		select.dispatchEvent(new Event('change'));
		expect(onChoose).not.toHaveBeenCalled();
	});
});

describe('KindPicker: a test', () => {
	it('is labelled Type of test and groups by the text before the dash, without it', () => {
		const { select } = mount({ kind: 'test' });
		expect(select.getAttribute('aria-label')).toBe('Type of test');
		expect(groups(select)).toEqual([
			['Non-destructive', ['Hardness']],
			['Destructive', ['Tensile']],
			['Dynamic', ['Fatigue']],
			['Other', ['Weighing']],
		]);
	});

	it('puts the NDE tests first: the live choices are "NDE — ..."', () => {
		const { select } = mount({ kind: 'test', testTypes: [{ value: 'tensile', name: 'Destructive — Tensile' }, { value: 'xrd', name: 'NDE — XRD' }, { value: 'fatigue', name: 'Dynamic — Fatigue' }, { value: 'weigh', name: 'Weighing' }] });
		expect(groups(select)).toEqual([['NDE', ['XRD']], ['Destructive', ['Tensile']], ['Dynamic', ['Fatigue']], ['Other', ['Weighing']]]);
	});

	it('emits the test type', async () => {
		const { select, onChoose } = mount({ kind: 'test' });
		select.value = 'tensile';
		select.dispatchEvent(new Event('change'));
		await nextTick();
		expect(onChoose).toHaveBeenCalledWith({ testType: 'tensile' });
	});
});
