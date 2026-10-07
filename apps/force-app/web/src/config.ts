// Service endpoints for the standalone app. The app runs on its OWN origin and talks to
// Directus + the filter/octree sidecars cross-origin (CORS + Bearer). Because the SPA is a
// static bundle, we support two configuration styles:
//   1. Build-time: VITE_* env vars (baked in). Good for a fixed deployment.
//   2. Runtime: an optional /config.json served next to index.html, so the SAME bundle can be
//      pointed at different Directus instances without a rebuild. Runtime wins when present.

export interface AppConfig {
	/** Directus REST base (items + assets + auth). No trailing slash. */
	directusUrl: string;
	/** Filter sidecar base (/run, /fft). No trailing slash. */
	filterUrl: string;
	/** Diag preview sidecar base (/preview). No trailing slash. */
	diagUrl: string;
	/** Octree static server base. No trailing slash; the app appends /<octreePath>/. */
	octreeUrl: string;
	/** Local recording backend (Phase 2). No trailing slash. */
	recorderUrl: string;
}

const stripSlash = (s: string) => s.replace(/\/+$/, '');
const LS_OVERRIDE = 'force-app.config.override';
const KEYS: (keyof AppConfig)[] = ['directusUrl', 'filterUrl', 'diagUrl', 'octreeUrl', 'recorderUrl'];

// Build-time defaults from env (fall back to same-origin relative paths for a co-hosted setup).
const defaults: AppConfig = {
	directusUrl: stripSlash(import.meta.env.VITE_DIRECTUS_URL ?? ''),
	filterUrl: stripSlash(import.meta.env.VITE_FILTER_URL ?? '/filter'),
	diagUrl: stripSlash(import.meta.env.VITE_DIAG_URL ?? '/diag'),
	octreeUrl: stripSlash(import.meta.env.VITE_OCTREE_URL ?? '/octrees'),
	recorderUrl: stripSlash(import.meta.env.VITE_RECORDER_URL ?? 'http://localhost:8200'),
};
const config: AppConfig = { ...defaults };
// What the config is WITHOUT the Settings override: env defaults plus /config.json. On the desktop
// shell /config.json carries the values resolved for THIS launch (the sidecar's actual port, the
// Directus URL), so they - not the build defaults - are what "Reset" returns to, and what Save
// compares against so it never pins a per-launch value into localStorage (review 2.8).
let base: AppConfig = { ...defaults };

function applyPartial(j: Partial<AppConfig> | null | undefined) {
	if (!j) return;
	for (const k of KEYS) if (j[k]) config[k] = stripSlash(j[k] as string);
}

// Precedence: env defaults < /config.json < localStorage override (Settings > Connectivity).
export async function loadRuntimeConfig(): Promise<void> {
	try {
		// Base-relative so it resolves to <base>config.json (e.g. /app/config.json) and never the
		// Directus origin root. Lets a deploy drop a config.json next to index.html to retarget URLs.
		const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
		if (res.ok) applyPartial((await res.json()) as Partial<AppConfig>);
	} catch {
		/* no runtime config file — env defaults stand */
	}
	base = { ...config };
	try {
		const stored = JSON.parse(localStorage.getItem(LS_OVERRIDE) || 'null');
		const kept = migrateStoredOverride(stored);
		if (kept !== stored) {
			try {
				if (kept && Object.keys(kept).length) localStorage.setItem(LS_OVERRIDE, JSON.stringify(kept));
				else localStorage.removeItem(LS_OVERRIDE);
			} catch { /* storage not writable: the pruned copy still applies for this session */ }
		}
		applyPartial(kept);
	} catch {
		/* no local override */
	}
}

// The desktop shell serves the SPA with the values resolved for THIS launch in /config.json.
function isDesktopBuild(): boolean {
	return import.meta.env.MODE === 'desktop' || (typeof window !== 'undefined' && !!window.forceApp);
}

// Older versions saved the whole Connectivity form, pinning all five endpoints (including the
// desktop's per-launch recorder URL) in localStorage for good. Drop what such a save left behind: a
// stored key equal to the base config is no override at all, and on the desktop a stored recorder
// URL must never beat the sidecar's value for this launch (8200 -> 8201 fallback). Returns the
// input object itself when nothing needed dropping.
function migrateStoredOverride(stored: Partial<AppConfig> | null | undefined): Partial<AppConfig> | null | undefined {
	if (!stored || typeof stored !== 'object') return stored;
	const kept: Partial<AppConfig> = {};
	let dropped = false;
	for (const k of KEYS) {
		const v = stored[k];
		if (v === undefined) continue;
		if (!v || stripSlash(v) === base[k] || (k === 'recorderUrl' && isDesktopBuild())) dropped = true;
		else kept[k] = v;
	}
	return dropped ? kept : stored;
}

export function getConfig(): Readonly<AppConfig> {
	return config;
}
export function getConfigDefaults(): Readonly<AppConfig> {
	return defaults;
}
/** The config without the Settings override (env defaults + /config.json). */
export function getConfigBase(): Readonly<AppConfig> {
	return base;
}

// Edit service URLs at runtime (Settings > Connectivity). Updates the live config in place, so
// subsequent requests use the new endpoints without a rebuild, and persists a localStorage override
// for the keys that DIFFER from the base config only. A key equal to its base value is not pinned
// (and drops any earlier override of it): the form is pre-filled with every live value, and saving
// them all used to freeze the desktop's per-launch recorder URL, so the 8200 -> 8201 fallback was
// defeated on the next launch.
export function setConfigOverride(partial: Partial<AppConfig>): void {
	applyPartial(partial);
	const existing: Partial<AppConfig> = (() => { try { return JSON.parse(localStorage.getItem(LS_OVERRIDE) || '{}') || {}; } catch { return {}; } })();
	for (const k of KEYS) {
		const v = partial[k];
		if (v === undefined) continue;
		if (stripSlash(v) === base[k] || !v) delete existing[k];
		else existing[k] = stripSlash(v);
	}
	if (Object.keys(existing).length) localStorage.setItem(LS_OVERRIDE, JSON.stringify(existing));
	else localStorage.removeItem(LS_OVERRIDE);
}
/** Drops the override and returns to the base config (env defaults + /config.json), not the build defaults. */
export function resetConfigOverride(): void {
	localStorage.removeItem(LS_OVERRIDE);
	for (const k of KEYS) config[k] = base[k];
}
