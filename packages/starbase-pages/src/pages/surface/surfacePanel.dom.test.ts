// @vitest-environment happy-dom
// The Surface scans panel and its Add dialog against a fake API: rows with thumbnails, "Render again" on a failed
// render only, an edge page that also asks for its insert's scans, the lab-wide warning in the dialog, the create it
// sends, and no write controls for a Lab Viewer. The 3D viewer itself is WebGL and is covered by the headless spec.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import SurfaceScansPanel from './SurfaceScansPanel.vue';

vi.mock('./viewer/SurfaceScanViewer.vue', () => ({ default: { props: ['scanId'], render() { return null; } } }));

const INSERT = '00000000-0000-4000-8000-0000000000a1';
const EDGE = '00000000-0000-4000-8000-0000000000e1';

const scan = (o: Record<string, unknown>) => ({
	scan_id: 's0', insert_id: INSERT, edge_id: null, condition: 'new', condition_note: null, scanned_on: null, notes: null, render_status: 'done', render_error: null,
	version: 1, directus_files_id: { id: 'f0', filename_download: 'a.al3d' }, operation_id: null, ...o,
});
const DONE = scan({ scan_id: 's-done', condition: 'worn', scanned_on: '2026-09-30', condition_note: 'flank wear', directus_files_id: { id: 'f1', filename_download: 'edge-A.al3d' } });
const FAILED = scan({ scan_id: 's-failed', edge_id: EDGE, insert_id: null, render_status: 'failed', render_error: 'Cannot read this file', directus_files_id: { id: 'f2', filename_download: 'bad.al3d' } });

function fakeApi(rows: unknown[]) {
	return {
		get: vi.fn(async (url: string, _config?: unknown) => {
			if (url === '/items/surface_scans') return { data: { data: rows } };
			if (url.endsWith('/thumb')) return { data: new Blob(['png'], { type: 'image/png' }) };
			if (url === '/files') return { data: { data: [{ id: 'f9', filename_download: 'new-scan.al3d', filesize: 2048, metadata: { archive_path: 'Alicona/new-scan.al3d' } }] } };
			return { data: { data: [] } };
		}),
		post: vi.fn(async () => ({ data: null })),
		patch: vi.fn(),
		delete: vi.fn(),
	};
}

const Plain = (tag: string) => defineComponent({ inheritAttrs: true, setup: (_p, { slots, attrs }) => () => h(tag, { ...attrs }, slots.default?.()) });
const Dialog = defineComponent({ props: ['modelValue'], setup: (p, { slots }) => () => (p.modelValue ? h('div', { role: 'dialog' }, slots.default?.()) : null) });
const Select = defineComponent({ props: ['modelValue', 'items'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('select', { 'data-items': (p.items ?? []).length, onChange: (e: Event) => emit('update:modelValue', p.items[Number((e.target as HTMLSelectElement).value)]?.value ?? null) }, (p.items ?? []).map((it: any, i: number) => h('option', { value: String(i) }, it.text))) });
const Input = defineComponent({ props: ['modelValue', 'type'], emits: ['update:modelValue'], setup: (p, { emit }) => () => h('input', { type: p.type ?? 'text', value: p.modelValue ?? '', onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value) }) });
function registerStubs(app: App) {
	app.component('v-button', defineComponent({ props: ['disabled', 'loading'], emits: ['click'], setup: (p, { slots, emit, attrs }) => () => h('button', { ...attrs, disabled: p.disabled, onClick: (e: Event) => emit('click', e) }, slots.default?.()) }));
	for (const n of ['v-icon', 'v-progress-circular']) app.component(n, Plain('span'));
	for (const n of ['v-card', 'v-card-title', 'v-card-text', 'v-card-actions', 'v-notice']) app.component(n, Plain('div'));
	app.component('v-dialog', Dialog);
	app.component('v-select', Select);
	app.component('v-input', Input);
	app.component('v-textarea', Input);
	app.directive('tooltip', {});
}

let app: App | null = null;
let api: ReturnType<typeof fakeApi>;

async function mountPanel(rows: unknown[], props: Record<string, unknown>, viewer = false) {
	api = fakeApi(rows);
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true),
		canViewAllAccess: ref(viewer), user: ref({ id: 'u1', role: 'r1' }),
	}));
	const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: Plain('div') }] });
	await router.push('/');
	app = createApp({ render: () => h(SurfaceScansPanel, props as any) });
	app.use(router);
	registerStubs(app);
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	await vi.waitFor(() => expect(document.querySelector('[data-testid="surface-scan-list"]')).not.toBeNull());
}

const text = () => document.body.textContent ?? '';
const button = (label: RegExp) => [...document.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const listReads = () => api.get.mock.calls.filter(([u]) => u === '/items/surface_scans');

beforeEach(() => {
	document.body.innerHTML = '';
	URL.createObjectURL = vi.fn(() => 'blob:thumb');
	URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	document.body.innerHTML = '';
});

describe('Surface scans panel', () => {
	it("lists the insert's scans with condition, date, note, status and a thumbnail for a finished render", async () => {
		await mountPanel([DONE], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		expect(text()).toContain('edge-A.al3d');
		expect(text()).toContain('Worn');
		expect(text()).toMatch(/30 Sep(t)? 2026/);
		expect(text()).toContain('flank wear');
		expect(text()).toContain('Ready');
		await vi.waitFor(() => expect(document.querySelector('.thumb img')?.getAttribute('src')).toBe('blob:thumb'));
		expect(api.get.mock.calls.some(([u]) => u === '/d1-surface-scan/s-done/thumb')).toBe(true);
		expect(button(/Open in 3D/)).toBeDefined();
		expect(button(/Render again/)).toBeDefined(); // a finished render can be rendered again too (its files may be gone)
		const read = listReads()[0][1] as any;
		expect(read.params.filter).toEqual({ insert_id: { _eq: INSERT } });
	});

	it("asks an edge page for the edge's scans and its insert's, tags the insert's, and offers Render again on a failed and on a finished render, never Open on a failed one", async () => {
		await mountPanel([DONE, FAILED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge CNMG12-1-3B' });
		const read = listReads()[0][1] as any;
		expect(read.params.filter).toEqual({ _or: [{ edge_id: { _eq: EDGE } }, { insert_id: { _eq: INSERT } }] });
		const rows = [...document.querySelectorAll('.scan')];
		expect(rows).toHaveLength(2);
		const done = rows.find((r) => r.textContent?.includes('edge-A.al3d'))!;
		const failed = rows.find((r) => r.textContent?.includes('bad.al3d'))!;
		expect(done.querySelector('.tag')?.textContent).toBe('Insert');
		expect(failed.querySelector('.tag')).toBeNull();
		expect(failed.textContent).toContain('Cannot read this file');
		expect(failed.textContent).toContain('Render again');
		expect(done.textContent).toContain('Render again');
		expect(failed.textContent).not.toContain('Open in 3D');
	});

	it('Render again posts to the endpoint and reloads the list', async () => {
		await mountPanel([FAILED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge CNMG12-1-3B' });
		const before = listReads().length;
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/d1-surface-scan/s-failed/render'));
		await vi.waitFor(() => expect(listReads().length).toBeGreaterThan(before));
	});

	it('says so when a Render again is refused', async () => {
		await mountPanel([FAILED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge' });
		api.post.mockRejectedValueOnce(Object.assign(new Error('no'), { response: { status: 403, data: { errors: [{ extensions: { code: 'FORBIDDEN' } }] } } }));
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(text()).toContain('do not have permission'));
	});

	it('shows an empty panel with its words, and the Add button', async () => {
		api = fakeApi([]);
		await mountPanel([], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' }).catch(() => {});
		await vi.waitFor(() => expect(text()).toContain('No surface scan of this insert.'));
		expect(button(/Add a surface scan/)).toBeDefined();
	});

	it('offers a Lab Viewer no Add and no Render again', async () => {
		await mountPanel([FAILED, DONE], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge' }, true);
		expect(button(/Add a surface scan/)).toBeUndefined();
		expect(button(/Render again/)).toBeUndefined();
		expect(button(/Open in 3D/)).toBeDefined();
	});
});

describe('Add a surface scan dialog', () => {
	it('warns that the file becomes visible to every lab member, then creates the scan with what was chosen', async () => {
		await mountPanel([DONE], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge CNMG12-1-3B' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		expect(document.querySelector('[data-testid="visibility-warning"]')?.textContent).toMatch(/visible to every lab member/);
		expect(text()).toContain('Add a surface scan to Edge CNMG12-1-3B');
		const submit = button(/Add surface scan$/)!;
		expect(submit.disabled).toBe(true);

		await vi.waitFor(() => expect(document.querySelector('.hit')).not.toBeNull());
		expect(document.querySelector('.hit')?.textContent).toContain('Alicona/new-scan.al3d');
		(document.querySelector('.hit') as HTMLButtonElement).click();
		await nextTick();
		const condition = document.querySelectorAll('select')[0] as HTMLSelectElement;
		condition.value = '1'; // Worn
		condition.dispatchEvent(new Event('change'));
		await nextTick();
		expect(button(/Add surface scan$/)!.disabled).toBe(false);
		button(/Add surface scan$/)!.click();
		await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
		expect(api.post).toHaveBeenCalledWith('/items/surface_scans', { directus_files_id: 'f9', condition: 'worn', edge_id: EDGE });
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
	});

	it('shows the database refusal of a file already added, and stays open', async () => {
		await mountPanel([DONE], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('.hit')).not.toBeNull());
		(document.querySelector('.hit') as HTMLButtonElement).click();
		await nextTick();
		const condition = document.querySelectorAll('select')[0] as HTMLSelectElement;
		condition.value = '0';
		condition.dispatchEvent(new Event('change'));
		await nextTick();
		api.post.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 400, data: { errors: [{ message: 'Value has to be unique', extensions: { code: 'RECORD_NOT_UNIQUE' } }] } } }));
		button(/Add surface scan$/)!.click();
		await vi.waitFor(() => expect(text()).toContain('This file is already a surface scan of this item.'));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it('does not offer a file this item already has', async () => {
		await mountPanel([scan({ scan_id: 's-have', directus_files_id: { id: 'f9', filename_download: 'new-scan.al3d' } })], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('.hit')).not.toBeNull());
		expect((document.querySelector('.hit') as HTMLButtonElement).disabled).toBe(true);
		expect(document.querySelector('.hit')?.textContent).toContain('already a surface scan here');
	});
});
