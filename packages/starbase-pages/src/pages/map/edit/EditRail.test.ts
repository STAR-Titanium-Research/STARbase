import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSSRApp, defineComponent, h, nextTick, reactive, ref } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { setExplorerHostFactory, type DraftBody, type ExplorerHost } from '@d1/ui';
import { apply, emptyBody, type DraftAction } from './draft';
import { fakeServer, settle } from './fakeBuildServer';
import EditRailChecks from './EditRailChecks.vue';
import EditRailItem from './EditRailItem.vue';
import MapRail from '../MapRail.vue';
import { EDIT_RAIL_KEY } from './railContext';
import { EDIT_MODE_KEY, useEditMode } from './useEditMode';

// The rail's edit sections, rendered on the server: what they draw while editing, and nothing otherwise.
beforeAll(() => {
	setExplorerHostFactory(() => ({ api: { get: async () => ({ data: { data: [] } }) }, isAdmin: ref(false), adminKnown: ref(true), user: ref(null), navigate() {}, openDataStudio() {}, fieldsFor: async () => [] }) as unknown as ExplorerHost);
});
afterAll(() => setExplorerHostFactory(null));

const VIcon = defineComponent({ props: { name: String }, setup: (p) => () => h('i', { class: 'v-icon' }, p.name) });
const VButton = defineComponent({ setup: (_p, { slots }) => () => h('button', slots.default?.()) });
const run = (actions: DraftAction[], from: DraftBody = emptyBody()): DraftBody => actions.reduce((b, a) => apply(b, a), from);

const SAMPLE_DEFS = [
	{ field: 'form', type: 'string', schema: { data_type: 'text', is_nullable: false }, meta: { interface: 'select-dropdown', required: true, sort: 1, width: 'half', options: { choices: [{ text: 'Disc', value: 'disc' }] }, translations: [{ language: 'en-US', translation: 'Geometry' }] } },
	{ field: 'notes', type: 'text', schema: { data_type: 'text' }, meta: { interface: 'input-multiline', sort: 9, width: 'full' } },
];

async function start(body: DraftBody, edit = true, selected?: string | object) {
	const server = fakeServer();
	server.s.seed('d', body);
	const route = reactive({ path: '/map', query: { edit: 'd' } as Record<string, unknown> });
	const mode = useEditMode({
		api: server.api,
		fieldsFor: async (c) => (c === 'physical_samples' ? SAMPLE_DEFS : []),
		route,
		router: { replace: vi.fn() },
		isPhone: ref(!edit),
		focus: () => null,
		selected: () => (typeof selected === 'object' ? (selected as never) : selected ? ({ id: `s:${selected}`, type: 'record', kind: 'sample', ref: { collection: 'physical_samples', id: selected, code: 'x' }, ins: [], outs: [] } as never) : undefined),
	});
	await settle();
	await nextTick();
	return mode;
}

async function render(component: unknown, mode: Awaited<ReturnType<typeof start>>, props: Record<string, unknown> = {}): Promise<string> {
	const app = createSSRApp({ render: () => h(component as never, props) });
	app.component('v-icon', VIcon);
	app.component('v-button', VButton);
	app.provide(EDIT_MODE_KEY, mode);
	app.provide(EDIT_RAIL_KEY, { labelFor: (k: string) => `card ${k}`, select() {}, openExternal() {}, showMissing: ref(false) });
	return renderToString(app);
}
const text = (html: string) => html.replace(/<!--.*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the rail\'s Checks', () => {
	it('lists what is missing by card while editing', async () => {
		const mode = await start(run([{ type: 'addSample' }]));
		const t = text(await render(EditRailChecks, mode));
		expect(t).toContain('Checks');
		expect(t).toContain('card n1');
		expect(t).toContain('Choose the material');
	});

	it('draws nothing on a phone, where a draft is only looked at', async () => {
		const mode = await start(run([{ type: 'addSample' }]), false);
		expect(await render(EditRailChecks, mode)).not.toContain('Checks');
	});
});

describe('the rail\'s form for the selected item', () => {
	it('draws the key settings and all fields of a new item that is selected', async () => {
		const mode = await start(run([{ type: 'addSample' }]), true, 'draft:n1');
		const html = await render(EditRailItem, mode);
		const t = text(html);
		expect(t).toContain('New sample: key settings');
		expect(t).toContain('New sample: all fields');
		expect(t).toContain('Geometry');
	});

	it('a new operation has the Planned / Done toggle at the top of its section; Done asks for the date it happened', async () => {
		const body = run([{ type: 'addSample' }, { type: 'addContainer', kind: 'operation', source: { from: 'blank', methodId: 'm' }, from: { key: 'n1' } }]);
		const container = { id: 'g:n3', type: 'container', kind: 'operation', group: { rowIds: ['draft:n3'] }, rows: [], slots: [] } as never;
		const mode = await start(body, true, container);
		const html = await render(EditRailItem, mode);
		expect(html).toContain('role="radiogroup"');
		expect(text(html)).toContain('New operation: key settings');
		expect(html).toMatch(/data-state="planned"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-state="planned"/);
		expect(text(html)).not.toContain('Create writes it as done');
		mode.setWorkState('n2', 'done');
		const done = await render(EditRailItem, mode);
		expect(done).toMatch(/data-state="done"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-state="done"/);
		expect(text(done)).toContain('Create writes it as done');
	});

	it('a sample has no Planned / Done toggle', async () => {
		const html = await render(EditRailItem, await start(run([{ type: 'addSample' }]), true, 'draft:n1'));
		expect(html).not.toContain('radiogroup');
	});

	it('draws nothing with nothing selected, outside edit mode, or for a card that is not in the draft', async () => {
		expect((await render(EditRailItem, await start(run([{ type: 'addSample' }]), true))).replace(/<!--.*?-->/g, '')).toBe('');
		expect((await render(EditRailItem, await start(run([{ type: 'addSample' }]), false, 'draft:n1'))).replace(/<!--.*?-->/g, '')).toBe('');
		expect((await render(EditRailItem, await start(run([{ type: 'addSample' }]), true, 'someone-else'))).replace(/<!--.*?-->/g, '')).toBe('');
	});

	it('waits for the record of an existing item before it draws its form', async () => {
		const mode = await start(run([{ type: 'addExistingSamples', samples: [{ id: 'ghost', version: 1 }] }]), true, 'ghost');
		expect(text(await render(EditRailItem, mode))).toContain('Reading the record');
	});
});

describe('the rail itself', () => {
	const props = { info: null, onMap: false, connections: {}, presentKinds: [], hiddenKinds: new Set<string>(), probable: true, reach: 2 };
	const rail = async (extra: Record<string, unknown>) => {
		const mode = await start(emptyBody());
		return render(MapRail, mode, { ...props, ...extra });
	};

	it('shows no Mark done for a card that cannot be marked done', async () => {
		expect(await rail({})).not.toContain('Mark done');
	});
});
