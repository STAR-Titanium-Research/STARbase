// @vitest-environment happy-dom
// The View rail in a DOM: open and collapse by click and by the `\` key, what it remembers per storage key, and the popover under 1100px.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import { ViewRail, ViewRailSection } from '@d1/ui';

const KEY = 'd1.view.test.open';
let app: App | null = null;
let host: HTMLElement;

async function mount(props: Record<string, unknown> = {}) {
	const Page = defineComponent({
		setup: () => () =>
			h('div', [
				h('input', { id: 'field' }),
				h(ViewRail, { storageKey: KEY, ...props }, () => h(ViewRailSection, { label: 'Panels' }, () => h('span', { class: 'choices' }, 'choices'))),
			]),
	});
	app = createApp(Page);
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('i', p.name) }));
	app.mount(host);
	await nextTick();
}

const press = (target: Element, key = '\\') => {
	target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
	return nextTick();
};
const isOpen = () => !!host.querySelector('.card .choices');

beforeEach(() => {
	window.innerWidth = 1600;
	localStorage.clear();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	app?.unmount();
	app = null;
	host.remove();
});

describe('ViewRail in a DOM', () => {
	it('starts collapsed unless told otherwise, and opens from the tab', async () => {
		await mount();
		expect(isOpen()).toBe(false);
		(host.querySelector('.tab') as HTMLElement).click();
		await nextTick();
		expect(isOpen()).toBe(true);
		expect(localStorage.getItem(KEY)).toBe('1');
	});

	it('collapses from the lid and remembers it', async () => {
		await mount({ defaultOpen: true });
		expect(isOpen()).toBe(true);
		(host.querySelector('.collapse') as HTMLElement).click();
		await nextTick();
		expect(isOpen()).toBe(false);
		expect(localStorage.getItem(KEY)).toBe('0');
	});

	it('comes back as it was left, over the default', async () => {
		localStorage.setItem(KEY, '1');
		await mount({ defaultOpen: false });
		expect(isOpen()).toBe(true);
	});

	it('toggles on the backslash key', async () => {
		await mount();
		await press(document.body);
		expect(isOpen()).toBe(true);
		await press(document.body);
		expect(isOpen()).toBe(false);
	});

	it('leaves the backslash to a field that has the keyboard', async () => {
		await mount();
		await press(host.querySelector('#field')!);
		expect(isOpen()).toBe(false);
	});

	it('keeps focus in the rail: the tab opens onto the collapse button and collapsing returns to the tab', async () => {
		await mount();
		(host.querySelector('.tab') as HTMLElement).click();
		await nextTick();
		expect(document.activeElement).toBe(host.querySelector('.collapse'));
		(host.querySelector('.collapse') as HTMLElement).click();
		await nextTick();
		expect(document.activeElement).toBe(host.querySelector('.tab'));
	});

	it('moves focus with the backslash only when it was already in the rail', async () => {
		await mount({ defaultOpen: true });
		(host.querySelector('.collapse') as HTMLElement).focus();
		await press(host.querySelector('.collapse')!);
		expect(document.activeElement).toBe(host.querySelector('.tab'));
		(host.querySelector('#field') as HTMLElement).focus();
		await press(document.body);
		expect(document.activeElement).toBe(host.querySelector('#field'));
	});

	it('becomes a button with a popover under 1100px, not remembered', async () => {
		window.innerWidth = 900;
		await mount();
		expect(host.querySelector('.pop-button')).toBeTruthy();
		expect(host.querySelector('.tab')).toBeNull();
		expect(host.querySelector('.choices')).toBeNull();
		const button = host.querySelector('.pop-button') as HTMLElement;
		expect(button.getAttribute('aria-expanded')).toBe('false');
		button.click();
		await nextTick();
		expect(host.querySelector('.pop .choices')).toBeTruthy();
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(button.getAttribute('aria-controls')).toBe(host.querySelector('.pop')!.id);
		expect(host.querySelector('.pop')!.getAttribute('role')).toBeNull();
		button.focus();
		await press(button, 'Escape');
		expect(host.querySelector('.pop')).toBeNull();
		expect(document.activeElement).toBe(button);
		expect(localStorage.getItem(KEY)).toBeNull();
	});
});
