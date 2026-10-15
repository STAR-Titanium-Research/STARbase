// @vitest-environment happy-dom
// The Inbox crawler tab: status, last scan, errors, the folders no one owns, the people with no uni alias, and Scan all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory, type HostApi } from '@d1/ui';
import InboxCrawlerPanel from './InboxCrawlerPanel.vue';
import { createFakeInbox } from './fakeInboxServer';

const Button = defineComponent({
	props: { disabled: Boolean, loading: Boolean },
	emits: ['click'],
	setup: (p, { slots, emit }) => () => h('button', { type: 'button', disabled: p.disabled || p.loading, onClick: () => emit('click') }, slots.default?.()),
});
const Span = defineComponent({ setup: (_p, { slots }) => () => h('span', slots.default?.()) });

let app: App | null = null;
let fake: ReturnType<typeof createFakeInbox>;

async function mount(admin?: Record<string, unknown>, wrap?: (a: HostApi) => HostApi) {
	fake = createFakeInbox({ admin });
	const api = wrap ? wrap(fake.api) : fake.api;
	setExplorerHostFactory(() => ({
		api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(true), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: Span }] });
	await router.push('/crawler?tab=inbox');
	app = createApp({ render: () => h(InboxCrawlerPanel) });
	app.use(router);
	app.component('v-button', Button);
	app.component('v-icon', Span);
	app.component('v-progress-circular', Span);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}

const q = (sel: string) => document.querySelector(sel);
const text = (sel: string) => q(sel)?.textContent ?? '';

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
});

describe('the Inbox crawler tab', () => {
	it('shows the daemon, the last scan, the folders no one owns and the people without an alias', async () => {
		await mount();
		await vi.waitFor(() => expect(q('[data-test="ic-daemon"]')).not.toBeNull());
		expect(text('[data-test="ic-daemon"]')).toBe('Online, running');
		expect(text('[data-test="ic-scan-state"]')).toMatch(/Last scan finished/);
		expect(text('[data-test="inbox-crawler"]')).toContain('Files registered');
		expect(text('[data-test="ic-unmatched"]')).toContain('Users/zz9');
		expect(text('[data-test="ic-unmatched"]')).toContain('Set it on the People page');
		expect(text('[data-test="ic-no-alias"]')).toContain('Bo Chan');
		expect(text('[data-test="ic-errors"]')).toBe('');
	});

	it('an offline daemon, an error and the last error are said', async () => {
		await mount({
			status: { desired_state: 'running', interval_minutes: 30, last_heartbeat_at: '2020-01-01T00:00:00Z', last_scan_started_at: '2026-10-15T10:00:00Z', error_count: 2, last_error: 'The share went away mid-scan.', files_registered: 5 },
			errors: [{ at: '2026-10-15T10:01:00Z', message: 'Scan request failed: share unavailable' }],
		});
		await vi.waitFor(() => expect(q('[data-test="ic-daemon"]')).not.toBeNull());
		expect(text('[data-test="ic-daemon"]')).toBe('Offline');
		expect(text('[data-test="ic-scan-state"]')).toContain('did not finish');
		expect(text('[data-test="ic-errors"]')).toContain('The share went away mid-scan.');
		expect(text('[data-test="ic-errors"]')).toContain('Scan request failed: share unavailable');
	});

	it('Scan all queues a scan and says so', async () => {
		await mount();
		await vi.waitFor(() => expect(q('[data-test="ic-scan-all"]')).not.toBeNull());
		(q('[data-test="ic-scan-all"]') as HTMLElement).click();
		await vi.waitFor(() => expect(text('[data-test="inbox-crawler"]')).toContain('Scan of every folder requested.'));
		expect(fake.calls.some((c) => c.method === 'post' && c.path === '/d1-inbox/admin/scan-all')).toBe(true);
	});

	it('says plainly when the server has no Inbox yet', async () => {
		await mount(undefined, (base) => ({ ...base, get: async () => { throw Object.assign(new Error('x'), { response: { status: 404, data: {} } }); } }));
		await vi.waitFor(() => expect(q('[data-test="ic-missing"]')).not.toBeNull());
		expect(text('[data-test="ic-missing"]')).toContain('d1-inbox is not deployed');
	});
});
