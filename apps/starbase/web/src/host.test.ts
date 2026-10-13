import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { resetLinks, useExplorerHost } from '@d1/ui';
import { createStarbaseHost, installStarbaseHost, resetStarbaseHost, sortFields, type HostDeps } from './host';
import type { Session } from './session';

const D1 = 'https://d1-server.tail54eeb6.ts.net';
const SID = '3f2b8a1c-0000-4000-8000-000000000001';

function fakeSession(id = 'u1'): Session {
	return {
		state: ref('signed-in'), user: ref({ id, first_name: 'Ada', role: 'r1' }), isAdmin: ref(false), adminKnown: ref(true),
		load: vi.fn(), ensure: vi.fn(), signIn: vi.fn(), signOut: vi.fn(), markSignedOut: vi.fn(),
	} as unknown as Session;
}
const fakeRouter = (path = '/') => ({ push: vi.fn(), currentRoute: ref({ fullPath: path }), afterEach: vi.fn(() => () => {}) });
const fakeApi = (fields: unknown[] = []) => ({
	get: vi.fn(async () => ({ data: { data: fields } })), post: vi.fn(async () => ({})), patch: vi.fn(), delete: vi.fn(),
});
function deps(over: Partial<HostDeps> & { routerPath?: string; userId?: string } = {}) {
	const router = fakeRouter(over.routerPath);
	const api = fakeApi();
	const d = { api, session: fakeSession(over.userId), router, directusUrl: D1, openWindow: vi.fn(), ...over } as unknown as HostDeps & {
		api: ReturnType<typeof fakeApi>; router: ReturnType<typeof fakeRouter>; openWindow: ReturnType<typeof vi.fn>;
	};
	return d;
}

afterEach(() => {
	resetStarbaseHost();
	resetLinks();
});

describe('the STARbase host', () => {
	it("openEditor is the dialog's, passed through", async () => {
		const openEditor = vi.fn(async () => 'saved' as const);
		const host = createStarbaseHost(deps({ openEditor }));
		await expect(host.openEditor?.('physical_samples', 's1')).resolves.toBe('saved');
		expect(openEditor).toHaveBeenCalledWith('physical_samples', 's1');
	});

	it('navigate takes Directus-form paths to STARbase routes', () => {
		const d = deps();
		const host = installStarbaseHost(d);
		host.navigate('/home/samples/1?x=1');
		host.navigate('/d1-force-dashboard?operation=9');
		expect(d.router.push.mock.calls.map((c) => c[0])).toEqual(['/samples/1?x=1', '/plot/force?operation=9']);
	});

	it('a Data Studio link opens d1-server in a new tab', () => {
		const d = deps();
		createStarbaseHost(d).openDataStudio('/content/materials/7');
		expect(d.openWindow).toHaveBeenCalledWith(`${D1}/admin/content/materials/7`);
	});

	it('fieldsFor asks d1-server and sorts as Data Studio does', async () => {
		const d = deps();
		d.api.get.mockResolvedValueOnce({ data: { data: [
			{ field: 'b', meta: { sort: 2 } }, { field: 'z', meta: null }, { field: 'a', meta: { sort: 1 } }, { field: 'c', meta: { sort: 2 } },
		] } });
		const fields = await createStarbaseHost(d).fieldsFor('physical_samples');
		expect(d.api.get).toHaveBeenCalledWith('/fields/physical_samples');
		expect(fields.map((f) => f.field)).toEqual(['a', 'b', 'c', 'z']);
	});

	it("isAdmin, adminKnown and user are the session's own refs", () => {
		const d = deps();
		const host = createStarbaseHost(d);
		expect(host.isAdmin).toBe(d.session.isAdmin);
		expect(host.adminKnown).toBe(d.session.adminKnown);
		expect(host.user).toBe(d.session.user);
	});
});

describe('installStarbaseHost', () => {
	it('before anyone signed in, the pages are told so', () => {
		expect(() => useExplorerHost()).toThrow(/no Explorer host/);
	});

	it('one host per signed-in user', () => {
		const d = deps();
		const first = installStarbaseHost(d);
		expect(installStarbaseHost(d)).toBe(first);
		expect(useExplorerHost()).toBe(first);
		d.session.user.value = { id: 'u2', role: null };
		expect(installStarbaseHost(d)).not.toBe(first);
	});

	it('visit pings use the Directus form, so both hosts count the same targets', () => {
		const d = deps({ routerPath: `/samples/${SID}` });
		installStarbaseHost(d);
		expect(d.api.post).toHaveBeenCalledWith('/d1-usage/visit', { kind: 'record', target: `physical_samples:${SID}` });
	});

	it('a plot page pings as its dashboard', () => {
		const d = deps({ routerPath: '/plot/force?operation=9', userId: 'u3' });
		installStarbaseHost(d);
		expect(d.api.post).toHaveBeenCalledWith('/d1-usage/visit', { kind: 'page', target: 'force-dashboard' });
	});
});

describe('sortFields', () => {
	it('by meta.sort, unsorted last, ties in their original order', () => {
		const defs = [{ field: 'x' }, { field: 'b', meta: { sort: 2 } }, { field: 'a', meta: { sort: 2 } }, { field: 'y', meta: { sort: 1 } }];
		expect(sortFields(defs).map((f) => f.field)).toEqual(['y', 'b', 'a', 'x']);
	});
});
