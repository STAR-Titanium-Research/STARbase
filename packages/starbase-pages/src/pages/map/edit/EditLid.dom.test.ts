// @vitest-environment happy-dom
// The Draft ▾ popup of the edit lid: the save status (kept, saving, or the error) first, then my drafts (the menu proper, which holds only them).
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import EditLid from './EditLid.vue';

let app: App | null = null;
afterEach(() => {
	app?.unmount();
	app = null;
	document.body.innerHTML = '';
});

function mount(props: Record<string, unknown>) {
	app = createApp({ render: () => h(EditLid as never, { name: 'S-1', canUndo: false, canRedo: false, drafts: [], ...props }) });
	app.component('v-icon', defineComponent({ setup: () => () => h('span') }));
	app.component('v-button', defineComponent({ setup: (_p, { slots }) => () => h('button', slots.default?.()) }));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	return el;
}
const open = async (el: HTMLElement) => {
	el.querySelector<HTMLElement>('button.ob')!.click();
	await nextTick();
	return el.querySelector('.pop');
};

describe('EditLid Draft menu', () => {
	it('is shut at first, with nothing of the save status or the list in the bar', () => {
		const el = mount({});
		expect(el.querySelector('[role=menu]')).toBeNull();
		expect(el.textContent).not.toContain('Draft kept');
	});

	it('holds the save status above my drafts', async () => {
		const el = mount({ drafts: [{ id: 'd1', name: 'First', summary: '1 sample', updated_at: '2026-10-01T00:00:00Z' }], currentId: 'd1' });
		const menu = await open(el);
		expect(menu?.querySelector('[role=status]')?.textContent).toBe('Draft kept');
		expect(menu?.textContent).toContain('My drafts');
		expect(menu?.querySelector('[role=menu] [role=status]'), 'the status is not inside the menu').toBeNull();
		expect(menu?.querySelector('[role=menu]')?.querySelectorAll('[role=menuitem]')).toHaveLength(1);
		expect(menu?.querySelector('[role=menuitem]')?.textContent).toContain('First');
		expect(menu!.innerHTML.indexOf('Draft kept')).toBeLessThan(menu!.innerHTML.indexOf('First'));
	});

	it('says Saving… and says a failed save in place of Draft kept', async () => {
		expect((await open(mount({ saving: true })))?.querySelector('[role=status]')?.textContent).toBe('Saving…');
		app?.unmount();
		document.body.innerHTML = '';
		const menu = await open(mount({ saveError: 'Could not reach the server; your changes are kept here.' }));
		expect(menu?.querySelector('[role=status]')?.textContent).toContain('Could not reach the server');
		expect(menu?.textContent).not.toContain('Draft kept');
	});

	it('asks the page for the list when it opens, and opens a draft from it', async () => {
		const opened: string[] = [];
		let menus = 0;
		const el = mount({ drafts: [{ id: 'd2', name: 'Second', summary: '', updated_at: '' }], onOpen: (id: string) => opened.push(id), onMenu: () => (menus += 1) });
		const menu = await open(el);
		expect(menus).toBe(1);
		(menu!.querySelector('[role=menuitem]') as HTMLElement).click();
		expect(opened).toEqual(['d2']);
	});
});
