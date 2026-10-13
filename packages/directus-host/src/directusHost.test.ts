import { beforeEach, describe, expect, it, vi } from 'vitest';

// useDirectusHost reads Directus's injection-based composables; here they are faked so the
// seed-then-correct behaviour of the signed-in user can be exercised without a Directus app.
const get = vi.fn();
const seed = { id: 'u1', first_name: 'Seeded', role: { id: 'r1' } };

vi.mock('@directus/extensions-sdk', () => ({
	useApi: () => ({ get }),
	useStores: () => ({ useUserStore: () => ({ currentUser: seed, isAdmin: false }) }),
}));
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The kit's index pulls in .vue components; only the pure admin guess is needed here.
vi.mock('@d1/ui', () => ({ guessAdmin: () => false }));

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('useDirectusHost user seed', () => {
	beforeEach(() => {
		vi.resetModules();
		get.mockReset();
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
