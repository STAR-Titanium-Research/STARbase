// @vitest-environment happy-dom
// The Files section of a record page (sample, operation and test pages share it) with imaging settings: a file the reader may not see is a locked
// file and nothing else; the owner of an SEM image sees its settings with an edit control per field; anyone else sees them without one. The
// answers are the d1-inbox contract fixtures (tests/fixtures/d1-inbox/sem_settings_*.json).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { setExplorerHostFactory, type HostApi, type LinkedFile } from '@d1/ui';
import SampleFiles from './SampleFiles.vue';

const DIR = join(import.meta.dirname, '../../../../../tests/fixtures/d1-inbox/') + '/';
const fx = (name: string) => JSON.parse(readFileSync(`${DIR}${name}.json`, 'utf8')) as { status: number; body: any };
const FILE = '00000000-0000-4000-8000-000000003001';

interface Call {
	method: string;
	path: string;
	params?: any;
	body?: any;
}
/** An axios-shaped client answering from fixtures: the GET and, when given, the PATCH. An error status rejects like axios. */
function fixtureApi(get: string, patch?: string) {
	const calls: Call[] = [];
	const answer = (name: string | undefined, call: Call) => {
		calls.push(call);
		if (!name) return Promise.reject(Object.assign(new Error('no route'), { response: { status: 404, data: { errors: [{ message: 'no route' }] } } }));
		const f = fx(name);
		return f.status >= 400
			? Promise.reject(Object.assign(new Error(`Request failed with status code ${f.status}`), { response: { status: f.status, data: f.body } }))
			: Promise.resolve({ data: f.body });
	};
	const api = {
		get: (path: string, config?: any) => answer(get, { method: 'GET', path, params: config?.params }),
		patch: (path: string, body?: any) => answer(patch, { method: 'PATCH', path, body }),
		post: () => Promise.reject(new Error('unexpected')),
		put: () => Promise.reject(new Error('unexpected')),
		delete: () => Promise.reject(new Error('unexpected')),
	} as unknown as HostApi;
	return { api, calls };
}

let app: App | null = null;
const upload = (name: string, id = FILE): LinkedFile => ({ id, name, kind: 'upload', source: 'data_files', unc: null, folder: null, fileUri: null });
const lockedFile = (id = FILE): LinkedFile => ({ id, name: '', kind: 'locked', source: 'data_files', unc: null, folder: null, fileUri: null });
/** A row of operation_files: its id is the share link's own, not a directus_files id. */
const shareFile = (name: string, id = 'share-link-1'): LinkedFile => ({
	id, name, kind: 'archive', source: 'share', unc: `\\\\host\\share\\runs\\${name}`, folder: '\\\\host\\share\\runs', fileUri: null,
});

function mount(files: LinkedFile[], api: HostApi) {
	setExplorerHostFactory(() => ({
		api, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true), canViewAllAccess: ref(false), user: ref({ id: 'u-me' }),
	}));
	app = createApp({ render: () => h(SampleFiles, { files, loading: false, error: '' }) });
	app.component('v-icon', defineComponent({ props: { name: String }, setup: (p) => () => h('span', { 'data-icon': p.name }) }));
	app.directive('tooltip', {});
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
	return el;
}

const items = () => [...document.querySelectorAll<HTMLElement>('[data-test="linked-file"]')];
const field = (key: string) => document.querySelector<HTMLElement>(`[data-field="${key}"]`);
const click = async (el: Element | null | undefined) => {
	(el as HTMLElement).click();
	await nextTick();
};
async function type(input: HTMLInputElement, text: string) {
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await nextTick();
}
const settled = () => vi.waitFor(() => expect(document.querySelector('[data-test="sem-loading"]')).toBeNull());

beforeEach(() => {
	document.body.innerHTML = '';
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
	document.body.innerHTML = '';
});

describe('a locked file', () => {
	it('is a lock and the words "A file from another person\'s folder", and nothing else', async () => {
		const { api, calls } = fixtureApi('sem_settings_owner');
		mount([lockedFile('00000000-0000-4000-8000-0000000099aa')], api);
		const [li] = items();
		expect(li.dataset.locked).toBe('true');
		expect(li.querySelector('[data-icon="lock"]')).not.toBeNull();
		expect(li.textContent!.trim()).toBe("A file from another person's folder");
		// no name, no values, no download or preview link, no owner, and no id in the page text
		expect(li.querySelector('a, [data-icon="download"], [data-icon="open_in_new"], [data-icon="content_copy"]')).toBeNull();
		expect(li.innerHTML).not.toContain('0000000099aa');
		expect(li.querySelector('[data-test="sem-settings"]')).toBeNull();
		// Directus already said it is unreadable: nothing is asked of the settings route
		expect(calls).toEqual([]);
	});

	it('is what the settings route says too: a readable name is taken off the row once the answer is locked', async () => {
		const { api, calls } = fixtureApi('sem_settings_locked');
		mount([upload('secret-sample.tif')], api);
		await vi.waitFor(() => expect(items()[0].dataset.locked).toBe('true'));
		const li = items()[0];
		expect(li.textContent!.trim()).toBe("A file from another person's folder");
		expect(li.innerHTML).not.toContain('secret-sample');
		expect(li.querySelector('a')).toBeNull();
		expect(li.querySelector('[data-icon="lock"]')).not.toBeNull();
		expect(calls).toEqual([{ method: 'GET', path: '/d1-inbox/sem-settings', params: { file: FILE }, body: undefined }]);
	});
});

describe('a file from the share (operation_files)', () => {
	it('asks nothing of the settings route, shows its path and copy buttons, and is never shown as locked', async () => {
		// the answer to any question would be locked: the id is not a directus_files id
		const { api, calls } = fixtureApi('sem_settings_locked');
		mount([shareFile('scan-01.tif'), shareFile('plot.png', 'share-link-2')], api);
		await settled();
		expect(calls).toEqual([]);
		const [li] = items();
		expect(li.dataset.locked).toBe('false');
		expect(li.textContent).toContain('scan-01.tif');
		expect(li.querySelector('[data-icon="lock"]')).toBeNull();
		expect(li.querySelectorAll('[data-icon="content_copy"], [data-icon="folder_copy"]')).toHaveLength(2);
		expect(li.querySelector('[data-test="sem-block"]')).toBeNull();
	});
});

describe("the owner's view", () => {
	it('shows the settings with their source and an edit control per field', async () => {
		const { api } = fixtureApi('sem_settings_owner');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(field('kv')).not.toBeNull());
		expect(items()[0].dataset.locked).toBe('false');
		expect(items()[0].textContent).toContain('sample-12.tif');
		expect(field('kv')!.textContent).toContain('15 kV');
		expect(field('kv')!.querySelector('[data-test="setting-source"]')!.textContent).toBe('metadata');
		expect(field('scale_bar_um')!.querySelector('[data-test="setting-check"]')).not.toBeNull();
		const edits = document.querySelectorAll('[data-test="edit-setting"]');
		expect(edits).toHaveLength(11);
		expect(field('kv')!.querySelector('[data-test="edit-setting"]')!.getAttribute('aria-label')).toBe('Edit kV');
	});

	it('saves a correction through PATCH { field, value } and then shows the field as manual', async () => {
		const { api, calls } = fixtureApi('sem_settings_owner', 'sem_settings_correct_ok');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(field('kv')).not.toBeNull());
		await click(field('kv')!.querySelector('[data-test="edit-setting"]'));
		const input = field('kv')!.querySelector<HTMLInputElement>('[data-test="edit-input"]')!;
		expect(input.value).toBe('15');
		await type(input, '20');
		await click(field('kv')!.querySelector('[data-test="edit-save"]'));
		await vi.waitFor(() => expect(field('kv')!.querySelector('[data-test="setting-source"]')!.textContent).toBe('manual'));
		expect(calls.at(-1)).toEqual({ method: 'PATCH', path: `/d1-inbox/sem-settings/${FILE}`, params: undefined, body: { field: 'kv', value: 20 } });
		expect(field('kv')!.textContent).toContain('20 kV');
		expect(field('kv')!.querySelector('[data-test="edit-input"]')).toBeNull();
	});

	it('shows the server\'s message beside the field on a 400, and keeps the box open', async () => {
		const { api } = fixtureApi('sem_settings_owner', 'sem_settings_correct_400_value');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(field('kv')).not.toBeNull());
		await click(field('kv')!.querySelector('[data-test="edit-setting"]'));
		await type(field('kv')!.querySelector<HTMLInputElement>('[data-test="edit-input"]')!, '99');
		await click(field('kv')!.querySelector('[data-test="edit-save"]'));
		await vi.waitFor(() => expect(field('kv')!.querySelector('[data-test="setting-error"]')).not.toBeNull());
		expect(field('kv')!.querySelector('[data-test="setting-error"]')!.textContent).toBe('That value is not valid for this setting.');
		expect(field('kv')!.querySelector('[data-test="edit-input"]')).not.toBeNull();
		expect(field('kv')!.querySelector('[data-test="setting-source"]')!.textContent).toBe('metadata');
	});

	it('says only the owner can correct it on a 403', async () => {
		const { api } = fixtureApi('sem_settings_owner', 'sem_settings_correct_403');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(field('kv')).not.toBeNull());
		await click(field('kv')!.querySelector('[data-test="edit-setting"]'));
		await type(field('kv')!.querySelector<HTMLInputElement>('[data-test="edit-input"]')!, '20');
		await click(field('kv')!.querySelector('[data-test="edit-save"]'));
		await vi.waitFor(() => expect(field('kv')!.querySelector('[data-test="setting-error"]')).not.toBeNull());
		expect(field('kv')!.querySelector('[data-test="setting-error"]')!.textContent).toBe("Only the file's owner can correct this.");
		expect(document.querySelectorAll('[data-test="edit-setting"]')).toHaveLength(0);
	});

	it('Cancel closes the box and sends nothing', async () => {
		const { api, calls } = fixtureApi('sem_settings_owner', 'sem_settings_correct_ok');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(field('kv')).not.toBeNull());
		await click(field('kv')!.querySelector('[data-test="edit-setting"]'));
		await click(field('kv')!.querySelector('[data-test="edit-cancel"]'));
		expect(field('kv')!.querySelector('[data-test="edit-input"]')).toBeNull();
		expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
	});
});

describe('anyone else who may read the file', () => {
	it('sees the settings and no edit control (an administrator, or a reader of an unowned file)', async () => {
		const { api } = fixtureApi('sem_settings_admin');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(field('kv')).not.toBeNull());
		expect(field('kv')!.textContent).toContain('15 kV');
		expect(document.querySelectorAll('[data-test="edit-setting"]')).toHaveLength(0);
		expect(document.querySelectorAll('[data-test="edit-input"]')).toHaveLength(0);
	});
});

describe('files that have no settings', () => {
	it('shows no settings block for a file with none saved', async () => {
		const { api, calls } = fixtureApi('sem_settings_none');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		await settled();
		expect(items()[0].dataset.locked).toBe('false');
		expect(document.querySelector('[data-test="sem-settings"]')).toBeNull();
		expect(items()[0].textContent).toContain('sample-12.tif');
	});

	it('does not ask for a file that cannot be an SEM image (a pdf, a mat file)', async () => {
		const { api, calls } = fixtureApi('sem_settings_owner');
		mount([upload('report.pdf', 'a'), upload('run.mat', 'b'), upload('noextension', 'c')], api);
		await settled();
		expect(calls).toEqual([]);
		expect(items()).toHaveLength(3);
	});

	it('keeps the file (name and download) when the settings call fails, and says so quietly', async () => {
		const { api } = fixtureApi('nope');
		mount([upload('sample-12.tif')], api);
		await vi.waitFor(() => expect(items()[0].querySelector('[data-test="sem-error"]')).not.toBeNull());
		expect(items()[0].textContent).toContain('sample-12.tif');
		expect(items()[0].dataset.locked).toBe('false');
		expect(items()[0].querySelector('a')).not.toBeNull();
	});
});

describe('a record with many images (final review I3)', () => {
	it('never has more than 4 settings requests in flight for 10 files mounted at once, and every file still gets its answer', async () => {
		let inFlight = 0;
		let peak = 0;
		let asked = 0;
		const owner = fx('sem_settings_owner');
		const api = {
			get: () => {
				asked += 1;
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				return new Promise((resolve) =>
					setTimeout(() => {
						inFlight -= 1;
						resolve({ data: owner.body });
					}, 5),
				);
			},
			patch: () => Promise.reject(new Error('unexpected')),
			post: () => Promise.reject(new Error('unexpected')),
			put: () => Promise.reject(new Error('unexpected')),
			delete: () => Promise.reject(new Error('unexpected')),
		} as unknown as HostApi;
		mount(Array.from({ length: 10 }, (_, i) => upload(`img-${i}.tif`, `00000000-0000-4000-8000-00000000${String(4000 + i)}`)), api);
		await vi.waitFor(() => expect(document.querySelectorAll('[data-test="sem-settings"]')).toHaveLength(10));
		expect(asked).toBe(10);
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBe(4);
	});
});
