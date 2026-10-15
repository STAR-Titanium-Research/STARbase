// @vitest-environment happy-dom
// Settings → Inbox: the auto-link switch with its consent text, off by default, turned on only through the confirm, and the Recently
// auto-linked list with its Undo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory, type HostApi } from '@d1/ui';
import AutoLinkSection from './AutoLinkSection.vue';
import { createFakeInbox, foundFile } from './fakeInboxServer';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, onClick: () => emit('click') }, slots.default?.()),
});
const Div = defineComponent({ setup: (_p, { slots }) => () => h('div', slots.default?.()) });
const Dialog = defineComponent({ props: { modelValue: Boolean }, setup: (p, { slots }) => () => (p.modelValue ? h('div', { role: 'dialog' }, slots.default?.()) : null) });

let app: App | null = null;
let fake: ReturnType<typeof createFakeInbox>;

async function mount(api?: (base: HostApi) => HostApi, autoLink = false, files = [foundFile({ state: 'linked', link_kind: 'auto', link_batch_id: 'b1', decided_at: '2026-10-15T09:00:00Z', linked_label: 'S-0042', linked_collection: 'physical_samples', linked_record_id: 'r1', rel_path: 'Users/ab1cd/sem/3fa9c1d2.tif' })]) {
	fake = createFakeInbox({ files, autoLink });
	const used = api ? api(fake.api) : fake.api;
	setExplorerHostFactory(() => ({
		api: used, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: Div }] });
	await router.push('/home/settings');
	app = createApp({ render: () => h(AutoLinkSection) });
	app.use(router);
	app.component('v-button', Button);
	app.component('v-dialog', Dialog);
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions']) app.component(n, Div);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}

const sw = () => document.querySelector<HTMLInputElement>('[data-test="autolink-switch"]')!;
const click = (el: Element | null | undefined) => (el as HTMLElement).click();

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
});

describe('Settings → Inbox', () => {
	it('is off by default and says what turning it on does, before it is turned on', async () => {
		await mount();
		await vi.waitFor(() => expect(sw()).not.toBeNull());
		await vi.waitFor(() => expect(sw().disabled).toBe(false));
		expect(sw().checked).toBe(false);
		const consent = document.querySelector('[data-test="autolink-consent"]')!.textContent!;
		expect(consent).toContain('Off. New files wait in your Inbox until you link them.');
		expect(consent).toContain('exactly one record that you can edit');
		expect(consent).toContain('Documents are never linked automatically');
		expect(consent).toContain('Recently auto-linked');
	});

	it('turning it on asks first, shows the consent text, and saves only on Turn on', async () => {
		await mount();
		await vi.waitFor(() => expect(sw().disabled).toBe(false));
		click(sw());
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Documents are never linked automatically');
		expect(fake.calls.some((c) => c.method === 'put')).toBe(false);
		expect(sw().checked).toBe(false);
		click(document.querySelector('[data-test="autolink-confirm"]'));
		await vi.waitFor(() => expect(sw().checked).toBe(true));
		expect(fake.calls.at(-1)).toMatchObject({ method: 'put', body: { auto_link: true } });
		expect(document.querySelector('[data-test="autolink-consent"]')!.textContent).toContain('On. New pictures');
	});

	it('cancelling the confirm leaves it off and sends nothing', async () => {
		await mount();
		await vi.waitFor(() => expect(sw().disabled).toBe(false));
		click(sw());
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		click([...document.querySelectorAll('[role="dialog"] button')].find((b) => /Cancel/.test(b.textContent ?? '')));
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		expect(sw().checked).toBe(false);
		expect(fake.calls.some((c) => c.method === 'put')).toBe(false);
	});

	it('turning it off is one click, with no confirm', async () => {
		await mount(undefined, true);
		await vi.waitFor(() => expect(sw().checked).toBe(true));
		click(sw());
		await vi.waitFor(() => expect(fake.calls.at(-1)).toMatchObject({ method: 'put', body: { auto_link: false } }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await vi.waitFor(() => expect(sw().checked).toBe(false));
	});

	it('lists the recently auto-linked files and undoes a batch', async () => {
		await mount();
		await vi.waitFor(() => expect(document.querySelector('[data-test="recently-auto-linked"] .fname')).not.toBeNull());
		const list = document.querySelector('[data-test="recently-auto-linked"]')!;
		expect(list.textContent).toContain('3fa9c1d2.tif');
		expect(list.textContent).toContain('S-0042');
		click(list.querySelector('[data-test="autolink-undo"]'));
		await vi.waitFor(() => expect(list.textContent).toContain('Nothing was linked automatically yet.'));
		expect(fake.files[0].state).toBe('new');
	});

	it('draws nothing at all when the server has no d1-inbox', async () => {
		await mount((base) => ({ ...base, get: async () => { throw Object.assign(new Error('x'), { response: { status: 404, data: {} } }); } }));
		await new Promise((r) => setTimeout(r, 30));
		expect(document.querySelector('[data-test="autolink-section"]')).toBeNull();
		expect(document.body.textContent).not.toContain('Inbox');
	});
});
