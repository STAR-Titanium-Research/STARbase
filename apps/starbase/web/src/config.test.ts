import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DIRECTUS_URL, DEV_DIRECTUS_URL, getConfig, loadRuntimeConfig, resolveConfig, type ConfigEnv } from './config';

const D1 = DEFAULT_DIRECTUS_URL;
const DEV = DEV_DIRECTUS_URL;

describe('resolveConfig', () => {
	it('a production build defaults to d1-server and the sidecars at their paths on it', () => {
		expect(resolveConfig({}, null, false)).toEqual({
			directusUrl: D1, filterUrl: `${D1}/filter`, diagUrl: `${D1}/diag`, octreeUrl: `${D1}/octrees`,
		});
	});
	it('a dev build defaults to the d1-starbase preview, never to live', () => {
		expect(DEV).toBe('http://127.0.0.1:18057');
		expect(resolveConfig({}, null, true)).toEqual({
			directusUrl: DEV, filterUrl: `${DEV}/filter`, diagUrl: `${DEV}/diag`, octreeUrl: `${DEV}/octrees`,
		});
		expect(resolveConfig({ VITE_DIRECTUS_URL: 'http://127.0.0.1:9' }, null, true).directusUrl).toBe('http://127.0.0.1:9');
		expect(resolveConfig({}, { directusUrl: 'https://d1.example' }, true).directusUrl).toBe('https://d1.example');
	});
	it('derives the sidecars from a directusUrl alone (production config.json is just that)', () => {
		expect(resolveConfig({}, { directusUrl: 'https://d1.example/' })).toEqual({
			directusUrl: 'https://d1.example', filterUrl: 'https://d1.example/filter', diagUrl: 'https://d1.example/diag', octreeUrl: 'https://d1.example/octrees',
		});
	});
	it('runtime beats build time, an explicit sidecar beats the derived one, trailing slashes go', () => {
		const env: ConfigEnv = { VITE_DIRECTUS_URL: 'http://127.0.0.1:18057', VITE_FILTER_URL: 'http://127.0.0.1:8000/' };
		expect(resolveConfig(env, null, false).filterUrl).toBe('http://127.0.0.1:8000');
		expect(resolveConfig(env, { directusUrl: 'https://d1.example' }, false).directusUrl).toBe('https://d1.example');
		expect(resolveConfig(env, { octreeUrl: 'https://o.example//' }, false).octreeUrl).toBe('https://o.example');
	});
	it('build-time sidecars still win when config.json is silent about directusUrl', () => {
		const env: ConfigEnv = { VITE_DIRECTUS_URL: 'http://127.0.0.1:18057', VITE_DIAG_URL: 'http://127.0.0.1:8001' };
		const c = resolveConfig(env, { octreeUrl: 'https://o.example' }, false);
		expect(c.diagUrl).toBe('http://127.0.0.1:8001');
		expect(c.filterUrl).toBe('http://127.0.0.1:18057/filter');
		expect(c.octreeUrl).toBe('https://o.example');
	});
	it('sidecars follow a runtime-moved origin: build-time sidecars are ignored when config.json sets directusUrl', () => {
		const env: ConfigEnv = { VITE_DIRECTUS_URL: 'http://127.0.0.1:18057', VITE_FILTER_URL: 'http://127.0.0.1:8000', VITE_DIAG_URL: 'http://127.0.0.1:8001', VITE_OCTREE_URL: 'http://127.0.0.1:8002' };
		expect(resolveConfig(env, { directusUrl: 'https://d1.example', diagUrl: 'https://diag.example/' }, false)).toEqual({
			directusUrl: 'https://d1.example', filterUrl: 'https://d1.example/filter', diagUrl: 'https://diag.example', octreeUrl: 'https://d1.example/octrees',
		});
	});
	it('blank values count as unset', () => {
		expect(resolveConfig({ VITE_DIRECTUS_URL: '  ' }, { directusUrl: '' }, false).directusUrl).toBe(D1);
	});
});

describe('loadRuntimeConfig', () => {
	it('applies /config.json, fetched without the cache', async () => {
		const f = vi.fn(async () => ({ ok: true, json: async () => ({ directusUrl: 'https://d1.example/' }) }));
		await loadRuntimeConfig(f as unknown as typeof fetch);
		expect(f).toHaveBeenCalledWith('/config.json', { cache: 'no-store' });
		expect(getConfig().directusUrl).toBe('https://d1.example');
		expect(getConfig().diagUrl).toBe('https://d1.example/diag');
	});
	it('keeps the build-time values when the file is missing, broken or unreachable', async () => {
		const buildTime = resolveConfig(import.meta.env as ConfigEnv, null);
		await loadRuntimeConfig((async () => ({ ok: false })) as unknown as typeof fetch);
		expect(getConfig()).toEqual(buildTime);
		await loadRuntimeConfig((async () => ({ ok: true, json: async () => 'nope' })) as unknown as typeof fetch);
		expect(getConfig()).toEqual(buildTime);
		await loadRuntimeConfig((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch);
		expect(getConfig()).toEqual(buildTime);
	});
});
