// @vitest-environment happy-dom
// The viewer's states that need no WebGL: a browser with no WebGL 2 (no "Try again" that can never work), and a done
// scan whose rendered files are gone from the object store (the endpoint's 404 OBJECT_MISSING: say so, and offer Render
// again to a member only).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, ref, type App } from 'vue';
import { setExplorerHostFactory } from '@d1/ui';
import SurfaceScanViewer from './viewer/SurfaceScanViewer.vue';
import { FILE_LOCKED_MESSAGE, OBJECT_MISSING_MESSAGE } from './scanApi';

const webgl2 = vi.hoisted(() => ({ on: true }));
vi.mock('./viewer/webgl2', () => ({ hasWebGL2: () => webgl2.on }));
vi.mock('./viewer/surfaceScene', () => ({ SurfaceScene: class { constructor() { throw new Error('the scene must not start in these tests'); } } }));

const META = { width: 3, height: 2, pixel_pitch_x_um: 5, pixel_pitch_y_um: 5, z_min_um: 0, z_max_um: 2 };
const httpError = (status: number, errors: unknown[]) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { errors } } });

function fakeApi(over: Partial<{ get: (url: string) => any }> = {}) {
	return {
		get: vi.fn(async (url: string) => {
			if (over.get) return over.get(url);
			if (url.endsWith('/meta')) return { data: META };
			if (url.endsWith('/grid')) return { data: new Float32Array([0, 1, 2, 1, NaN, 0]).buffer };
			return { data: {} };
		}),
		post: vi.fn(async () => ({ data: { data: { render_status: 'pending' } } })),
		patch: vi.fn(),
		delete: vi.fn(),
	};
}

const Plain = (tag: string) => defineComponent({ inheritAttrs: true, setup: (_p, { slots, attrs }) => () => h(tag, { ...attrs }, slots.default?.()) });
let app: App | null = null;
let api: ReturnType<typeof fakeApi>;
const rerendered = vi.fn();
const locked = vi.fn();

async function mountViewer(over: Parameters<typeof fakeApi>[0] = {}, viewer = false) {
	api = fakeApi(over);
	setExplorerHostFactory(() => ({
		api: api as any, navigate: () => {}, openDataStudio: () => {}, fieldsFor: async () => [], isAdmin: ref(false), adminKnown: ref(true),
		canViewAllAccess: ref(viewer), user: ref({ id: 'u1', role: 'r1' }),
	}));
	app = createApp({ render: () => h(SurfaceScanViewer, { scanId: 's1', onRerendered: rerendered, onLocked: locked }) });
	app.component('v-button', defineComponent({ props: ['loading'], emits: ['click'], setup: (p, { slots, emit }) => () => h('button', { onClick: () => emit('click') }, slots.default?.()) }));
	for (const n of ['v-icon', 'v-progress-circular']) app.component(n, Plain('span'));
	const el = document.createElement('div');
	document.body.appendChild(el);
	app.mount(el);
}

const text = () => document.body.textContent ?? '';
const button = (label: RegExp) => [...document.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

beforeEach(() => {
	document.body.innerHTML = '';
	webgl2.on = true;
	rerendered.mockClear();
	locked.mockClear();
});
afterEach(() => {
	app?.unmount();
	app = null;
	setExplorerHostFactory(null);
});

describe('SurfaceScanViewer without WebGL 2', () => {
	it('says it cannot draw, offers no Try again, still shows the facts, and never starts a scene', async () => {
		webgl2.on = false;
		await mountViewer();
		await vi.waitFor(() => expect(document.querySelector('[data-phase="no-webgl"]')).not.toBeNull());
		expect(text()).toContain('cannot draw the 3D view');
		expect(text()).toContain('3 × 2 cells');
		expect(button(/Try again/)).toBeUndefined();
		expect(document.querySelector('canvas')).toBeNull();
	});
});

describe('SurfaceScanViewer when the rendered data is missing', () => {
	const missing = () => httpError(404, [{ message: OBJECT_MISSING_MESSAGE, extensions: { code: 'OBJECT_MISSING' } }]);

	it('shows the endpoint’s message and Render again, which posts and tells the panel', async () => {
		await mountViewer({ get: () => { throw missing(); } });
		await vi.waitFor(() => expect(document.querySelector('[data-phase="error"]')).not.toBeNull());
		expect(text()).toContain('The rendered data is missing; render the scan again.');
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith('/d1-surface-scan/s1/render'));
		await vi.waitFor(() => expect(rerendered).toHaveBeenCalled());
	});

	it('is also found when only /grid says so (its error body is bytes)', async () => {
		const bytes = httpError(404, []);
		(bytes as any).response.data = new TextEncoder().encode(JSON.stringify({ errors: [{ message: OBJECT_MISSING_MESSAGE, extensions: { code: 'OBJECT_MISSING' } }] })).buffer;
		await mountViewer({ get: (url) => { if (url.endsWith('/meta')) return { data: META }; throw bytes; } });
		await vi.waitFor(() => expect(button(/Render again/)).toBeDefined());
	});

	it('offers a Lab Viewer no Render again, and an ordinary failure none either', async () => {
		await mountViewer({ get: () => { throw missing(); } }, true);
		await vi.waitFor(() => expect(document.querySelector('[data-phase="error"]')).not.toBeNull());
		expect(button(/Render again/)).toBeUndefined();
		expect(button(/Try again/)).toBeDefined();
		document.body.innerHTML = '';
		app?.unmount();
		await mountViewer({ get: () => { throw httpError(500, [{ message: 'boom' }]); } });
		await vi.waitFor(() => expect(text()).toContain('boom'));
		expect(button(/Render again/)).toBeUndefined();
	});

	it('says why a Render again was refused', async () => {
		await mountViewer({ get: () => { throw missing(); } });
		await vi.waitFor(() => expect(button(/Render again/)).toBeDefined());
		api.post.mockRejectedValueOnce(httpError(403, [{ extensions: { code: 'FORBIDDEN' } }]));
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(text()).toContain('do not have permission'));
		expect(rerendered).not.toHaveBeenCalled();
		expect(locked).not.toHaveBeenCalled();
	});

	it('tells the panel when the file became private meanwhile (Render again refused with 403 FILE_LOCKED)', async () => {
		await mountViewer({ get: () => { throw missing(); } });
		await vi.waitFor(() => expect(button(/Render again/)).toBeDefined());
		api.post.mockRejectedValueOnce(httpError(403, [{ extensions: { code: 'FILE_LOCKED' } }]));
		button(/Render again/)!.click();
		await vi.waitFor(() => expect(locked).toHaveBeenCalledTimes(1));
		expect(text()).toContain(FILE_LOCKED_MESSAGE);
		expect(rerendered).not.toHaveBeenCalled();
	});
});

describe('SurfaceScanViewer on a scan whose file belongs to someone else', () => {
	it('says so in words (403 FILE_LOCKED), offers no Render again, and shows no facts', async () => {
		await mountViewer({ get: () => { throw httpError(403, [{ message: 'locked', extensions: { code: 'FILE_LOCKED' } }]); } });
		await vi.waitFor(() => expect(document.querySelector('[data-phase="error"]')).not.toBeNull());
		expect(text()).toContain("This scan's file belongs to someone else, so it cannot be shown.");
		expect(text()).toContain(FILE_LOCKED_MESSAGE);
		expect(text()).not.toContain('do not have permission');
		expect(button(/Render again/)).toBeUndefined();
		expect(document.querySelector('canvas')).toBeNull();
		expect(locked).toHaveBeenCalledTimes(1); // the panel is told, to reload its list and show the row as a lock tile
	});
	it('says the same when only /grid is refused (its body is bytes), and tells the panel', async () => {
		const bytes = httpError(403, []);
		(bytes as any).response.data = new TextEncoder().encode(JSON.stringify({ errors: [{ message: 'locked', extensions: { code: 'FILE_LOCKED' } }] })).buffer;
		await mountViewer({ get: (url) => { if (url.endsWith('/meta')) return { data: META }; throw bytes; } });
		await vi.waitFor(() => expect(text()).toContain(FILE_LOCKED_MESSAGE));
		expect(locked).toHaveBeenCalledTimes(1);
	});
	it('does not tell the panel of any other refusal or failure', async () => {
		await mountViewer({ get: () => { throw httpError(403, [{ message: 'no', extensions: { code: 'FORBIDDEN' } }]); } });
		await vi.waitFor(() => expect(document.querySelector('[data-phase="error"]')).not.toBeNull());
		expect(text()).toContain('do not have permission');
		expect(locked).not.toHaveBeenCalled();
	});
});
