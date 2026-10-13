import { afterEach, describe, expect, it } from 'vitest';
import { createSSRApp, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ExplorerNav, setExplorerHostFactory, type ExplorerHost } from '@d1/ui';

// The app shell renders the navigation above any ExplorerView, so no ancestor provides the host:
// the kit components must get it from the factory the app installed.
const fake: ExplorerHost = {
	api: {
		get: async () => ({ data: { data: [] } }),
		post: async () => ({ data: {} }),
		patch: async () => ({ data: {} }),
		delete: async () => ({ data: {} }),
	},
	navigate: () => {},
	openDataStudio: () => {},
	fieldsFor: async () => [],
	isAdmin: ref(false),
	adminKnown: ref(true),
	user: ref(null),
};

describe('kit components outside ExplorerView', () => {
	afterEach(() => setExplorerHostFactory(null));

	it('ExplorerNav renders with only the host factory installed (no provide)', async () => {
		setExplorerHostFactory(() => fake);
		const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)*', component: { render: () => null } }] });
		await router.push('/home');
		const app = createSSRApp(ExplorerNav);
		app.use(router);
		const html = await renderToString(app);
		expect(html).toContain('<nav');
	});
});
