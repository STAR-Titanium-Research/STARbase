import { beforeEach, describe, expect, it, vi } from 'vitest';

// useDirectusHost reads Directus's injection-based composables; here they are faked so the
// seed-then-correct behaviour of the signed-in user can be exercised without a Directus app.
const get = vi.fn();
const seed = { id: 'u1', first_name: 'Seeded', role: { id: 'r1' } };

vi.mock('@directus/extensions-sdk', () => ({
	useApi: () => ({ get }),
	useStores: () => ({ useUserStore: () => ({ currentUser: seed, isAdmin: false }) }),
}));
const push = vi.hoisted(() => vi.fn());
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }));
// The kit's index pulls in .vue components; only the pure admin guess and the real link
// resolution (links.ts has no Vue in it) are needed here.
vi.mock('@d1/ui', async () => {
	const links = await import('../../d1-ui/src/links');
	return { guessAdmin: () => false, openLink: links.openLink };
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('useDirectusHost user seed', () => {
	beforeEach(() => {
		vi.resetModules();
		get.mockReset();
		push.mockReset();
		vi.unstubAllGlobals();
	});

	it('keeps the seeded user when /users/me fails', async () => {
		get.mockImplementation((url: string) =>
			url === '/users/me' ? Promise.reject(new Error('offline')) : Promise.resolve({ data: { data: { admin_access: false } } }),
		);
		const { useDirectusHost } = await import('./directusHost');
		const host = useDirectusHost();
		await settle();
		expect(host.user.value).toEqual({ id: 'u1', first_name: 'Seeded', role: 'r1' });
	});

	it('replaces the seed with the server answer on success', async () => {
		get.mockImplementation((url: string) =>
			url === '/users/me'
				? Promise.resolve({ data: { data: { id: 'u1', first_name: 'Server', role: 'r2' } } })
				: Promise.resolve({ data: { data: { admin_access: false } } }),
		);
		const { useDirectusHost } = await import('./directusHost');
		const host = useDirectusHost();
		expect(host.user.value?.first_name).toBe('Seeded');
		await settle();
		expect(host.user.value).toEqual({ id: 'u1', first_name: 'Server', role: 'r2' });
	});
});

describe('useDirectusHost navigation', () => {
	beforeEach(() => {
		vi.resetModules();
		get.mockReset();
		push.mockReset();
		get.mockResolvedValue({ data: { data: { admin_access: false } } });
	});

	// No DOM environment in this package's vitest, so window is stubbed rather than spied on.
	it('navigate opens a STARbase page through the permanent link in a new tab, not the router', async () => {
		const open = vi.fn().mockReturnValue(null);
		vi.stubGlobal('window', { open });
		const { useDirectusHost } = await import('./directusHost');
		const host = useDirectusHost();
		host.navigate('/home/samples/1');
		expect(open).toHaveBeenCalledWith('/d1-links/go/p/samples/1', '_blank', 'noopener');
		expect(push).not.toHaveBeenCalled();
		host.openDataStudio('/d1-force-dashboard?operation=9');
		expect(open).toHaveBeenCalledWith('/d1-links/go/p/plot/force?operation=9', '_blank', 'noopener');
		vi.unstubAllGlobals();
	});

	it('navigate pushes a Data Studio path on the router', async () => {
		const open = vi.fn().mockReturnValue(null);
		vi.stubGlobal('window', { open });
		const { useDirectusHost } = await import('./directusHost');
		const host = useDirectusHost();
		host.navigate('/content/x/1');
		expect(push).toHaveBeenCalledWith('/content/x/1');
		expect(open).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
