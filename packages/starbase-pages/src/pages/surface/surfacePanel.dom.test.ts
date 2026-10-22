// @vitest-environment happy-dom
// The Surface scans panel and its Add dialog against a fake API: rows (GET /d1-surface-scan/scans) with thumbnails,
// "Render again" on a failed or finished render, an edge page that also asks for its insert's scans, a locked scan as a
// lock tile (condition, date and operation only, no thumbnail request, no buttons, still counted), the visibility warning
// in the dialog, the create it sends, and no write controls for a Lab Viewer. The 3D viewer itself is WebGL and is covered by the headless spec.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { setExplorerHostFactory } from '@d1/ui';
import SurfaceScansPanel from './SurfaceScansPanel.vue';

// The viewer is WebGL: a stand-in that can say the scan is locked (what the real one does on a 403 FILE_LOCKED), as the test asks.
const viewerHook = vi.hoisted(() => ({ locked: null as null | (() => void) }));
vi.mock('./viewer/SurfaceScanViewer.vue', () => ({
	default: { props: ['scanId'], emits: ['locked', 'rerendered'], setup(p: { scanId: string }, { emit }: any) { viewerHook.locked = () => emit('locked', p.scanId); return () => null; } },
}));

const INSERT = '00000000-0000-4000-8000-0000000000a1';
const EDGE = '00000000-0000-4000-8000-0000000000e1';

const httpError = (status: number, code: string) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { errors: [{ message: code, extensions: { code } }] } } });

const scan = (o: Record<string, unknown>) => ({
	scan_id: 's0', insert_id: INSERT, edge_id: null, locked: false, condition: 'new', scanned_on: null, operation: null, notes: null, condition_note: null,
	added_by: null, file: { id: 'f0', name: 'a.al3d' }, render_status: 'done', render_error: null, rendered_at: null, grid: { width: 2, height: 2 }, can_edit: true, ...o,
});
const DONE = scan({ scan_id: 's-done', condition: 'worn', scanned_on: '2026-09-30', condition_note: 'flank wear', file: { id: 'f1', name: 'edge-A.al3d' } });
const FAILED = scan({ scan_id: 's-failed', edge_id: EDGE, insert_id: null, render_status: 'failed', render_error: 'Cannot read this file', file: { id: 'f2', name: 'bad.al3d' } });
// What the endpoint sends for a scan whose file belongs to someone else: nothing but condition, date and operation.
const LOCKED = { scan_id: 's-locked', insert_id: INSERT, edge_id: null, locked: true, condition: 'cleaned', scanned_on: '2026-08-15', operation: { id: 'op-9', label: 'OP-LOCK-9' } };

// Library files the dialog lists: the first is a legacy file with no owner, the second is owned by a person, the third by a team.
const FILES = [
	{ id: 'f9', filename_download: 'new-scan.al3d', filesize: 2048, metadata: { archive_path: 'Alicona/new-scan.al3d' }, owner_person_id: null, owner_team_id: null },
	{ id: 'f10', filename_download: 'mine.al3d', filesize: 4096, metadata: { archive_path: 'Alicona/mine.al3d' }, owner_person_id: 'p-1', owner_team_id: null },
	{ id: 'f11', filename_download: 'team.al3d', filesize: 4096, metadata: { archive_path: 'Alicona/team.al3d' }, owner_person_id: null, owner_team_id: 't-1' },
];
const UNOWNED_SENTENCE = 'No owner: every lab member will see this scan and its file.';
const OWNED_SENTENCE = "This file has an owner: only the owner (or their team) and administrators will see this scan's file and 3D view; others see that the item has a scan.";

// `state.rows` is what the next list read answers (a test changes it to say a scan became private); `state.thumb` may throw.
function fakeApi(rows: unknown[]) {
	const state = { rows, thumb: null as null | ((url: string) => unknown) };
	return {
		state,
		get: vi.fn(async (url: string, _config?: unknown) => {
			if (url === '/d1-surface-scan/scans') return { data: { data: state.rows } };
			if (url.endsWith('/thumb')) { state.thumb?.(url); return { data: new Blob(['png'], { type: 'image/png' }) }; }
			if (url === '/files') return { data: { data: FILES } };
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

async function mountPanel(rows: unknown[], props: Record<string, unknown>, viewer = false, reuseApi = false) {
	if (!reuseApi) api = fakeApi(rows);
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
const listReads = () => api.get.mock.calls.filter(([u]) => u === '/d1-surface-scan/scans');

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
		expect(read.params).toEqual({ insert_id: INSERT });
		expect(api.get.mock.calls.some(([u]) => u === '/items/surface_scans')).toBe(false); // not the table: the endpoint decides what is shown
	});

	it("asks an edge page for the edge's scans and its insert's, tags the insert's, and offers Render again on a failed and on a finished render, never Open on a failed one", async () => {
		await mountPanel([DONE, FAILED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge CNMG12-1-3B' });
		const read = listReads()[0][1] as any;
		expect(read.params).toEqual({ insert_id: INSERT, edge_id: EDGE }); // an edge page passes both ids
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

const LOCKED2 = { ...LOCKED, scan_id: 's-locked-2', scanned_on: '2026-08-01' };

describe('a locked scan', () => {
	const LOCKED_TEXT = 'A surface scan you cannot open: its file belongs to someone else';
	it('is a lock tile with the condition, date and operation, and no file, notes, thumbnail, Open or Render again', async () => {
		await mountPanel([DONE, LOCKED], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		const tile = document.querySelector('.scan[data-locked="true"]')!;
		expect(tile).not.toBeNull();
		expect(tile.textContent).toContain(LOCKED_TEXT);
		expect(tile.textContent).toContain('Cleaned');
		expect(tile.textContent).toMatch(/15 Aug 2026/);
		expect(tile.textContent).toContain('OP-LOCK-9');
		expect(tile.querySelector('img')).toBeNull();
		expect(tile.querySelector('button')).toBeNull();
		expect(tile.textContent).not.toMatch(/Open in 3D|Render again|Ready|Waiting|Rendering|failed/i);
		// the readable one beside it is unchanged
		const readable = [...document.querySelectorAll('.scan')].find((r) => r.textContent?.includes('edge-A.al3d'))!;
		expect(readable.textContent).toContain('Render again');
		expect(document.querySelectorAll('.scan')).toHaveLength(2);
	});
	it('counts in the section total and is never asked for a thumbnail', async () => {
		await mountPanel([LOCKED, LOCKED2], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		await vi.waitFor(() => expect(document.querySelectorAll('.scan')).toHaveLength(2));
		expect(document.querySelector('#scans')?.textContent).toMatch(/Surface scans\s*2/);
		await new Promise((r) => setTimeout(r, 50));
		expect(api.get.mock.calls.some(([u]) => String(u).includes('/thumb'))).toBe(false);
		expect(api.get.mock.calls.some(([u]) => String(u).includes('s-locked'))).toBe(false);
	});
	it('does not show a file, notes or render state even if a faulty answer carried them', async () => {
		await mountPanel([{ ...LOCKED, file: { id: 'f9', name: 'secret-scan.al3d' }, notes: 'private note', condition_note: 'private cond', render_status: 'failed', render_error: 'private error', can_edit: true }], { insertId: INSERT, itemLabel: 'Insert' });
		expect(text()).not.toMatch(/secret-scan|private/);
		expect(button(/Render again|Open in 3D/)).toBeUndefined();
	});
	it('keeps a locked scan out of the files the Add dialog calls taken, and its readable neighbours in', async () => {
		await mountPanel([DONE, { ...LOCKED, file: { id: 'f9', name: 'new-scan.al3d' } }], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('.hit')).not.toBeNull());
		expect((document.querySelector('.hit') as HTMLButtonElement).disabled).toBe(false); // f9 is in the library list and not taken: a locked row has no file id here
	});
	it('offers a Lab Viewer nothing on it either, and an edge page tags an insert’s locked scan', async () => {
		await mountPanel([LOCKED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge' }, true);
		const tile = document.querySelector('.scan[data-locked="true"]')!;
		expect(tile.querySelector('.tag')?.textContent).toBe('Insert');
		expect(tile.querySelector('button')).toBeNull();
	});
});

describe('Add a surface scan dialog', () => {
	it('warns who sees the scan (the file’s owner, not the lab), then creates the scan with what was chosen', async () => {
		await mountPanel([DONE], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge CNMG12-1-3B' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
		expect(document.querySelector('[data-testid="visibility-warning"]')?.textContent).toContain("Only the file's owner (or its team) and administrators see this scan's file and 3D view");
		expect(document.querySelector('[data-testid="visibility-warning"]')?.textContent).not.toContain('makes this file visible to every lab member');
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

	it("asks for the files' owner columns and says per file whether it has an owner, in the list and under the chosen file", async () => {
		await mountPanel([DONE], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelectorAll('.hit')).toHaveLength(3));
		const read = api.get.mock.calls.find(([u]) => u === '/files')![1] as any;
		expect(read.params.fields).toEqual(expect.arrayContaining(['owner_person_id', 'owner_team_id']));
		const hits = [...document.querySelectorAll('.hit')];
		expect(hits.map((h) => h.querySelector('[data-testid="hit-owner"]')?.textContent)).toEqual([UNOWNED_SENTENCE, OWNED_SENTENCE, OWNED_SENTENCE]);
		// nothing under a file yet: the sentence of the chosen one follows the pick, not the first hit
		expect(document.querySelector('[data-testid="file-visibility"]')).toBeNull();
		(hits[0] as HTMLButtonElement).click();
		await nextTick();
		expect(document.querySelector('[data-testid="file-visibility"]')?.textContent).toBe(UNOWNED_SENTENCE);
		[...document.querySelectorAll('button')].find((b) => b.textContent === 'Change')!.click();
		await nextTick();
		(document.querySelectorAll('.hit')[2] as HTMLButtonElement).click(); // owned by a team
		await nextTick();
		expect(document.querySelector('[data-testid="file-visibility"]')?.textContent).toBe(OWNED_SENTENCE);
		expect(document.querySelector('[data-testid="visibility-warning"]')?.textContent).toContain("Only the file's owner (or its team)"); // the generic warning stays
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

	it('shows the access guard’s reason in words when the person cannot read the file, and stays open', async () => {
		await mountPanel([DONE], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('.hit')).not.toBeNull());
		(document.querySelector('.hit') as HTMLButtonElement).click();
		await nextTick();
		const condition = document.querySelectorAll('select')[0] as HTMLSelectElement;
		condition.value = '0';
		condition.dispatchEvent(new Event('change'));
		await nextTick();
		const reason = 'You can only add a surface scan of a file you can see.';
		api.post.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 403, data: { errors: [{ message: reason, extensions: { code: 'FORBIDDEN', reason, source: 'd1-access-guard', kind: 'junction', collection: 'surface_scans', parent: 'directus_files' } }] } } }));
		button(/Add surface scan$/)!.click();
		await vi.waitFor(() => expect(text()).toContain(reason));
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it('does not offer a file this item already has', async () => {
		await mountPanel([scan({ scan_id: 's-have', file: { id: 'f9', name: 'new-scan.al3d' } })], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		button(/Add a surface scan/)!.click();
		await vi.waitFor(() => expect(document.querySelector('.hit')).not.toBeNull());
		expect((document.querySelector('.hit') as HTMLButtonElement).disabled).toBe(true);
		expect(document.querySelector('.hit')?.textContent).toContain('already a surface scan here');
	});
});

describe('a scan that became private after the list was read (403 FILE_LOCKED)', () => {
	const goPrivate = () => { api.state.rows = [{ ...LOCKED, scan_id: 's-done', insert_id: INSERT }]; };
	const row = () => document.querySelector('.scan')!;

	it('comes back as a lock tile when the open viewer says so: no file name, thumbnail, status or buttons, view closed, thumbnail URL given back', async () => {
		await mountPanel([DONE], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' });
		await vi.waitFor(() => expect(document.querySelector('.thumb img')?.getAttribute('src')).toBe('blob:thumb'));
		button(/Open in 3D/)!.click();
		await vi.waitFor(() => expect(document.querySelector('[data-testid="surface-scan-open"]')).not.toBeNull());
		const before = listReads().length;
		(URL.revokeObjectURL as any).mockClear();
		goPrivate();
		viewerHook.locked!();
		await vi.waitFor(() => expect(row().getAttribute('data-locked')).toBe('true'));
		expect(listReads().length).toBe(before + 1);
		expect(document.querySelector('[data-testid="surface-scan-open"]')).toBeNull();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:thumb');
		expect(row().textContent).toContain('A surface scan you cannot open: its file belongs to someone else');
		expect(row().textContent).not.toMatch(/edge-A\.al3d|flank wear|Ready|Open in 3D|Render again/);
		expect(row().querySelector('img')).toBeNull();
		expect(row().querySelector('button')).toBeNull();
	});

	it('Render again refused with FILE_LOCKED reloads the list, and the row is a lock tile', async () => {
		await mountPanel([FAILED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge CNMG12-1-3B' });
		const before = listReads().length;
		api.post.mockRejectedValueOnce(httpError(403, 'FILE_LOCKED'));
		api.state.rows = [{ ...LOCKED, scan_id: 's-failed', insert_id: null, edge_id: EDGE }];
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(row().getAttribute('data-locked')).toBe('true'));
		expect(listReads().length).toBe(before + 1);
		expect(row().querySelector('button')).toBeNull();
		expect(row().textContent).not.toMatch(/bad\.al3d|Cannot read this file|belongs to someone else, so it cannot be shown/); // the tile has its own words only
	});

	it('does not reload for any other Render again refusal', async () => {
		await mountPanel([FAILED], { insertId: INSERT, edgeId: EDGE, itemLabel: 'Edge' });
		const before = listReads().length;
		api.post.mockRejectedValueOnce(httpError(403, 'FORBIDDEN'));
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(text()).toContain('do not have permission'));
		expect(listReads().length).toBe(before);
	});

	it('a thumbnail answered with FILE_LOCKED reloads the list too', async () => {
		api = fakeApi([DONE]);
		api.state.thumb = () => { api.state.rows = [{ ...LOCKED, scan_id: 's-done', insert_id: INSERT }]; throw httpError(403, 'FILE_LOCKED'); };
		await mountPanel([DONE], { insertId: INSERT, itemLabel: 'Insert CNMG12-1' }, false, true);
		await vi.waitFor(() => expect(row().getAttribute('data-locked')).toBe('true'));
	});
});
