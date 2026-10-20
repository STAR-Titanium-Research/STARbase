// @vitest-environment happy-dom
// What a record page hands its frame to pin: nothing while the record is loading or when it is not found or not visible, the record once it has loaded.
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory, usePagePin } from '@d1/ui';
import { setPageFrame } from '../frame';
import SamplePage from './SamplePage.vue';

const SAMPLE = '00000000-0000-4000-8000-000000000001';
let app: App | null = null;

// The frame shows what it would pin; a page that is not found has a 403 for its record.
async function mountSample(found: boolean) {
	const get = async (url: string) => {
		if (url === `/items/physical_samples/${SAMPLE}`) {
			if (!found) throw Object.assign(new Error('403'), { response: { status: 403 } });
			await new Promise((r) => setTimeout(r, 30));
			return { data: { data: { sample_id: SAMPLE, sample_code: 'SM-001', form: 'bar' } } };
		}
		if (url.startsWith('/d1-trace/')) return { data: { sample: { sample_id: SAMPLE }, stock_origins: [], ancestors: [], descendants: [], events: [], hidden: {}, truncated: {} } };
		return { data: { data: [] } };
	};
	setExplorerHostFactory(() => ({ api: { get, post: async () => ({}) } as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), user: ref({ id: 'u', role: 'r' }) }) as any);
	setPageFrame(defineComponent({
		props: { title: String },
		setup(_p, { slots }) {
			const pin = usePagePin();
			return () => h('div', [h('p', { id: 'pin' }, pin.value ? `${pin.value.kind}:${pin.value.target}` : 'no pin'), slots.default?.()]);
		},
	}));
	window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
	await router.push('/');
	app = createApp({ render: () => h(SamplePage, { id: SAMPLE }) });
	app.use(router);
	const Nothing = defineComponent({ setup: () => () => null });
	for (const n of ['v-button', 'v-icon', 'v-input', 'v-notice', 'v-progress-circular', 'v-chip']) app.component(n, defineComponent({ setup: (_p, { slots }) => () => h('span', slots.default?.()) }));
	for (const n of ['v-dialog', 'v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-drawer', 'v-form']) app.component(n, Nothing);
	app.directive('tooltip', {});
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await nextTick();
}
const pinText = () => document.querySelector('#pin')?.textContent;

afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	setPageFrame(null);
	document.body.innerHTML = '';
});

describe('a record page and the title pin', () => {
	it('offers no pin while the record loads, then pins the record', async () => {
		await mountSample(true);
		expect(pinText()).toBe('no pin');
		await new Promise((r) => setTimeout(r, 120));
		await nextTick();
		expect(pinText()).toBe(`record:physical_samples:${SAMPLE}`);
	});

	it('offers no pin for a record that is not visible', async () => {
		await mountSample(false);
		await new Promise((r) => setTimeout(r, 60));
		await nextTick();
		expect(document.body.textContent).toContain('Not found or not visible');
		expect(pinText()).toBe('no pin');
	});
});
