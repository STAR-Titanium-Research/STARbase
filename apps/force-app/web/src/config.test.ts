import { beforeEach, describe, expect, it, vi } from 'vitest';

// Review 2.8: Connectivity Save must not pin per-launch values, and Reset must return to the
// desktop's config.json, not the build defaults.

function memoryStorage(init: Record<string, string> = {}) {
	const m = new Map(Object.entries(init));
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); }, dump: () => Object.fromEntries(m) };
}

async function boot(runtimeJson: unknown, stored: Record<string, string> = {}) {
	vi.resetModules();
	const ls = memoryStorage(stored);
	vi.stubGlobal('localStorage', ls);
	vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => runtimeJson })));
	const cfg = await import('./config');
	await cfg.loadRuntimeConfig();
	return { cfg, ls };
}

const DESKTOP = { recorderUrl: 'http://127.0.0.1:8201', directusUrl: 'https://d1.example' };
const OVERRIDE = 'force-app.config.override';

beforeEach(() => { vi.unstubAllGlobals(); });

describe('Connectivity Save', () => {
	it('persists only the keys that differ from the base config', async () => {
		const { cfg, ls } = await boot(DESKTOP);
		// the form is pre-filled with every live value; the operator changes only the filter URL
		cfg.setConfigOverride({ ...cfg.getConfig(), filterUrl: 'https://filter.example' });
		expect(JSON.parse(ls.dump()[OVERRIDE])).toEqual({ filterUrl: 'https://filter.example' });
		expect(cfg.getConfig().filterUrl).toBe('https://filter.example');
	});

	it('does not pin the per-launch recorder URL, so a later launch on 8200 is not overridden', async () => {
		const { cfg, ls } = await boot(DESKTOP);
		cfg.setConfigOverride({ ...cfg.getConfig() });
		expect(ls.dump()[OVERRIDE]).toBeUndefined();
	});

	it('editing a key back to its base value drops the override of it', async () => {
		const { cfg, ls } = await boot(DESKTOP, { [OVERRIDE]: JSON.stringify({ filterUrl: '/old', recorderUrl: 'http://localhost:9999' }) });
		expect(cfg.getConfig().recorderUrl).toBe('http://localhost:9999');
		cfg.setConfigOverride({ recorderUrl: 'http://127.0.0.1:8201/' });
		expect(JSON.parse(ls.dump()[OVERRIDE])).toEqual({ filterUrl: '/old' });
		expect(cfg.getConfig().recorderUrl).toBe('http://127.0.0.1:8201');
	});
});

describe('Connectivity Reset', () => {
	it('returns to the desktop config.json values, not the build defaults', async () => {
		const { cfg, ls } = await boot(DESKTOP, { [OVERRIDE]: JSON.stringify({ directusUrl: 'https://elsewhere', filterUrl: '/f' }) });
		expect(cfg.getConfig().directusUrl).toBe('https://elsewhere');
		cfg.resetConfigOverride();
		expect(cfg.getConfig().directusUrl).toBe('https://d1.example');
		expect(cfg.getConfig().recorderUrl).toBe('http://127.0.0.1:8201');
		expect(cfg.getConfig().filterUrl).toBe(cfg.getConfigDefaults().filterUrl);
		expect(ls.dump()[OVERRIDE]).toBeUndefined();
	});
});

describe('stored overrides from versions that pinned every endpoint', () => {
	const pinnedAll = (over: Record<string, string> = {}) => JSON.stringify({
		directusUrl: 'https://d1.example', filterUrl: '/filter', diagUrl: '/diag', octreeUrl: '/octrees',
		recorderUrl: 'http://127.0.0.1:8200', ...over,
	});

	it('drops stored keys equal to the base config and rewrites the storage', async () => {
		const { cfg, ls } = await boot({ directusUrl: 'https://d1.example', recorderUrl: 'http://127.0.0.1:8200' }, {
			[OVERRIDE]: pinnedAll({ filterUrl: 'https://filter.example/' }),
		});
		expect(JSON.parse(ls.dump()[OVERRIDE])).toEqual({ filterUrl: 'https://filter.example/' });
		expect(cfg.getConfig().filterUrl).toBe('https://filter.example');
		expect(cfg.getConfig().recorderUrl).toBe('http://127.0.0.1:8200');
	});

	it('removes the override entirely when nothing differs from the base', async () => {
		const { ls } = await boot({ directusUrl: 'https://d1.example', recorderUrl: 'http://127.0.0.1:8200' }, { [OVERRIDE]: pinnedAll() });
		expect(ls.dump()[OVERRIDE]).toBeUndefined();
	});

	it('in the desktop build the sidecar\'s recorder URL wins over a stored one', async () => {
		vi.stubGlobal('window', { forceApp: {} });
		const { cfg, ls } = await boot(DESKTOP, { [OVERRIDE]: pinnedAll({ recorderUrl: 'http://127.0.0.1:8200' }) });
		expect(cfg.getConfig().recorderUrl).toBe('http://127.0.0.1:8201');
		expect(JSON.parse(ls.dump()[OVERRIDE] ?? '{}').recorderUrl).toBeUndefined();
	});

	it('in a browser build a stored recorder URL that differs is still honoured', async () => {
		const { cfg } = await boot(DESKTOP, { [OVERRIDE]: JSON.stringify({ recorderUrl: 'http://localhost:9999' }) });
		expect(cfg.getConfig().recorderUrl).toBe('http://localhost:9999');
	});
});
