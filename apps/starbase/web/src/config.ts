// Where STARbase finds d1-server. STARbase is a static bundle on its own origin, and every call goes to
// d1-server directly with the Directus session cookie (spec §3, ADR-0013). There are two sources, and the
// later one wins: build-time VITE_* variables (development: VITE_DIRECTUS_URL=http://127.0.0.1:18057),
// then /config.json at boot (production: Caddy answers it from D1_SERVER_ORIGIN, infra/caddy/Caddyfile).
// The sidecars default to their paths on the Directus origin, so a config of just { directusUrl } is complete.
// When config.json moves the origin, the sidecars move with it: build-time sidecar variables apply only
// when config.json does not set directusUrl. A dev build never defaults to live: with nothing configured it
// talks to the d1-starbase preview, and only a production build falls back to d1-server.

export interface StarbaseConfig {
	directusUrl: string;
	filterUrl: string;
	diagUrl: string;
	octreeUrl: string;
}
export type ConfigEnv = Partial<Record<'VITE_DIRECTUS_URL' | 'VITE_FILTER_URL' | 'VITE_DIAG_URL' | 'VITE_OCTREE_URL', string>>;

export const DEFAULT_DIRECTUS_URL = 'https://d1-server.tail54eeb6.ts.net';
export const DEV_DIRECTUS_URL = 'http://127.0.0.1:18057';

const strip = (s: string): string => s.trim().replace(/\/+$/, '');
// The first value that is a non-blank string, without its trailing slashes.
function pick(...values: unknown[]): string | undefined {
	for (const v of values) if (typeof v === 'string' && strip(v) !== '') return strip(v);
	return undefined;
}

export function resolveConfig(env: ConfigEnv, runtime: Partial<StarbaseConfig> | null, dev: boolean = import.meta.env.DEV): StarbaseConfig {
	const runtimeOrigin = pick(runtime?.directusUrl);
	const directusUrl = runtimeOrigin ?? pick(env.VITE_DIRECTUS_URL) ?? (dev ? DEV_DIRECTUS_URL : DEFAULT_DIRECTUS_URL);
	// Build-time sidecars belong to the build-time origin, so a runtime-moved origin ignores them.
	const buildTime = (v: string | undefined) => (runtimeOrigin ? undefined : v);
	return {
		directusUrl,
		filterUrl: pick(runtime?.filterUrl, buildTime(env.VITE_FILTER_URL)) ?? `${directusUrl}/filter`,
		diagUrl: pick(runtime?.diagUrl, buildTime(env.VITE_DIAG_URL)) ?? `${directusUrl}/diag`,
		octreeUrl: pick(runtime?.octreeUrl, buildTime(env.VITE_OCTREE_URL)) ?? `${directusUrl}/octrees`,
	};
}

let config: StarbaseConfig = resolveConfig(import.meta.env as ConfigEnv, null);

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<StarbaseConfig> {
	let runtime: Partial<StarbaseConfig> | null = null;
	try {
		const res = await fetchImpl('/config.json', { cache: 'no-store' });
		if (res.ok) {
			const json: unknown = await res.json();
			if (json && typeof json === 'object' && !Array.isArray(json)) runtime = json as Partial<StarbaseConfig>;
		}
	} catch {
		// No runtime file (development, tests): the build-time values stand.
	}
	config = resolveConfig(import.meta.env as ConfigEnv, runtime);
	return config;
}

export function getConfig(): Readonly<StarbaseConfig> {
	return config;
}
