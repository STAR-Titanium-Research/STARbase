import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { configureLinks, resetLinks, starbaseLinks } from '@d1/ui';
import type { HostApi } from '@d1/ui';

// onMounted never runs in a server render, so the block would only ever draw its state before the first read. The composable
// is replaced by one that has already read (createMyDrafts, tested in useMyDrafts.test.ts); this checks the markup.
const holder = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('./useMyDrafts', async (orig) => ({ ...(await orig<typeof import('./useMyDrafts')>()), useMyDrafts: () => holder.state }));

import MyDrafts from './MyDrafts.vue';
import { createMyDrafts } from './useMyDrafts';

const RouterLink = defineComponent({ props: { to: String }, setup: (p, { slots }) => () => h('a', { class: 'router-link', href: p.to }, slots.default?.()) });
const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const apiOf = (get: HostApi['get']): HostApi => ({ get, post: async () => ({ data: {} }), patch: async () => ({ data: {} }), delete: async () => ({ data: {} }) });
const fail = (status: number) => Object.assign(new Error('x'), { response: { status } });

async function render(get: HostApi['get']): Promise<string> {
	const state = createMyDrafts(apiOf(get));
	await state.load();
	holder.state = state;
	const app = createSSRApp(MyDrafts);
	app.component('router-link', RouterLink);
	app.component('v-icon', VIcon);
	return renderToString(app);
}

afterEach(() => resetLinks());

describe('MyDrafts', () => {
	it('lists drafts as links that reopen them in edit mode', async () => {
		configureLinks(starbaseLinks(''));
		const html = await render(async () => ({
			data: {
				data: [
					{ id: 'd1', name: 'S-1 · 14 Oct', updated_at: '2026-10-14T10:00:00Z', summary: '2 operations, 4 samples' },
					{ id: 'd2', name: 'New process · 13 Oct', updated_at: '2026-10-13T10:00:00Z', summary: '' },
				],
			},
		}));
		expect(text(html)).toContain('My drafts');
		expect(html).toContain('href="/map?edit=d1"');
		expect(html).toContain('href="/map?edit=d2"');
		expect(text(html)).toContain('S-1 · 14 Oct');
		expect(text(html)).toContain('2 operations, 4 samples');
		expect(text(html)).toContain('Updated 14 Oct 2026');
	});

	it('in Data Studio the links open STARbase through the permanent links', async () => {
		const html = await render(async () => ({ data: { data: [{ id: 'd1', name: 'A', updated_at: '', summary: '' }] } }));
		expect(html).toContain('href="/d1-links/go/p/map?edit=d1"');
	});

	it('draws nothing when there are no drafts', async () => {
		expect(text(await render(async () => ({ data: { data: [] } })))).toBe('');
	});

	it('draws nothing when the endpoint 404s', async () => {
		expect(text(await render(async () => { throw fail(404); }))).toBe('');
	});

	it('fails on its own line, as an alert', async () => {
		const html = await render(async () => { throw fail(500); });
		expect(html).toContain('role="alert"');
		expect(text(html)).toContain('Could not read your drafts');
	});

	it('says how many more there are beyond the first few', async () => {
		const rows = Array.from({ length: 11 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, updated_at: `2026-10-${10 + i}T00:00:00Z`, summary: '' }));
		const html = await render(async () => ({ data: { data: rows } }));
		expect(html.match(/\?edit=d\d+"/g)).toHaveLength(8);
		expect(text(html)).toContain('and 3 more');
	});
});
