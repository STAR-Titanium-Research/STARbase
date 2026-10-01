// Offline copy of the reference data the Metadata pickers search (samples, operators, machines,
// tools, inserts, edges, methods). Without it every picker is empty the moment the database is
// unreachable, so a cut recorded offline could not be linked to its sample and could never be
// uploaded properly later. While connected the app keeps a snapshot in IndexedDB (localStorage is
// too small for a full sample list); directusLookups.ts searches it when the server can't be reached.
//
// The snapshot holds the same raw rows the online queries return (same `fields`), so the online
// and offline paths share one row -> LookupItem mapping.
import { reactive, watch } from 'vue';
import { api } from '../directusClient';
import { authStore } from '../authStore';
import { hasServerSession } from '../recorder';

export type Entity = 'samples' | 'people' | 'equipment' | 'tools' | 'inserts' | 'edges' | 'methods';

interface Spec { collection: string; pk: string; fields: string[]; filter?: Record<string, any> }

// `fields` here are what BOTH the online search and the offline mapper read.
export const SPECS: Record<Entity, Spec> = {
	samples: { collection: 'physical_samples', pk: 'sample_id', fields: ['sample_id', 'sample_code', 'diameter_mm', 'nickname', 'code_sort'] },
	people: { collection: 'people', pk: 'person_id', fields: ['person_id', 'full_name', 'is_operator'] },
	equipment: { collection: 'equipment', pk: 'equipment_id', fields: ['equipment_id', 'equipment_name', 'equipment_code', 'equipment_type', 'is_active'] },
	tools: { collection: 'tools', pk: 'tool_id', fields: ['tool_id', 'tool_code', 'tool_name', 'tool_type', 'is_active'] },
	inserts: { collection: 'cutting_inserts', pk: 'insert_id', fields: ['insert_id', 'insert_code', 'insert_number', 'insert_type_id.type_code', 'is_depleted'] },
	edges: { collection: 'insert_edges', pk: 'edge_id', fields: ['edge_id', 'edge_code', 'edge_identifier', 'is_used', 'insert_id.insert_id', 'insert_id.insert_code'] },
	methods: { collection: 'manufacturing_methods', pk: 'method_id', fields: ['method_id', 'method_name', 'method_code'] },
};
const ENTITIES = Object.keys(SPECS) as Entity[];

// ---- storage -------------------------------------------------------------------------------
export interface KvStore {
	get(key: string): Promise<any | undefined>;
	set(key: string, value: any): Promise<void>;
}

function idbStore(): KvStore {
	let dbp: Promise<IDBDatabase> | null = null;
	const open = () =>
		(dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open('force-app-offline', 1);
			req.onupgradeneeded = () => req.result.createObjectStore('kv');
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		}));
	const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
		const db = await open();
		return new Promise<T>((resolve, reject) => {
			const r = fn(db.transaction('kv', mode).objectStore('kv'));
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
	};
	return {
		get: (k) => tx('readonly', (s) => s.get(k)),
		set: async (k, v) => { await tx('readwrite', (s) => s.put(v, k)); },
	};
}

let store: KvStore | null = null;
const kv = (): KvStore => (store ??= idbStore());
/** Tests inject an in-memory store. */
export function setLookupStore(s: KvStore | null): void { store = s; memo.clear(); }

// Parsed snapshot per entity, so a keystroke doesn't re-read IndexedDB.
const memo = new Map<Entity, any[] | null>();

export const lookupStatus = reactive<{
	syncing: boolean;
	syncedAt: number | null;
	counts: Partial<Record<Entity, number>>;
	error: string | null;
}>({ syncing: false, syncedAt: null, counts: {}, error: null });

/** The cached rows for an entity, or null if none have ever been stored. */
export async function cachedRows(e: Entity): Promise<any[] | null> {
	if (memo.has(e)) return memo.get(e) ?? null;
	let rows: any[] | null = null;
	try {
		const v = await kv().get(`rows:${e}`);
		rows = Array.isArray(v) ? v : null;
	} catch { /* no IndexedDB -> behave as never cached */ }
	memo.set(e, rows);
	return rows;
}

export async function storeRows(e: Entity, rows: any[]): Promise<void> {
	await kv().set(`rows:${e}`, rows);
	memo.set(e, rows);
	lookupStatus.counts[e] = rows.length;
}

/** Load the timestamp/counts of the last snapshot (Settings shows them before any sync runs). */
export async function loadLookupStatus(): Promise<void> {
	try {
		const m = await kv().get('meta');
		if (m) { lookupStatus.syncedAt = m.syncedAt ?? null; lookupStatus.counts = m.counts ?? {}; }
	} catch { /* ignore */ }
}

// ---- refresh -------------------------------------------------------------------------------
const PAGE = 1000;
const MAX_PAGES = 200;

async function fetchAll(spec: Spec): Promise<any[]> {
	const out: any[] = [];
	const seen = new Set<string>();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const res = await api.get(`/items/${spec.collection}`, {
			params: { fields: spec.fields, limit: PAGE, page, sort: spec.pk, ...(spec.filter ? { filter: spec.filter } : {}) },
		});
		const rows: any[] = res.data?.data ?? [];
		for (const r of rows) {
			const id = String(r[spec.pk]);
			if (!seen.has(id)) { seen.add(id); out.push(r); }
		}
		if (rows.length < PAGE) break;
	}
	return out;
}

let inFlight: Promise<void> | null = null;
// Entities whose last refresh failed. They are retried on their own (not the whole download) until
// they succeed, and the snapshot only counts as fresh once none are left.
let failedEntities: Entity[] = [];

/**
 * Re-download `only` (default: every entity). All-or-nothing per entity: a failed fetch keeps that
 * entity's previous snapshot, so a flaky connection can never shrink what the picker can find
 * offline. `syncedAt` is stamped only when nothing is left failing.
 */
export function syncLookups(only: Entity[] = ENTITIES): Promise<void> {
	if (inFlight) return inFlight;
	if (!hasServerSession()) return Promise.resolve();
	inFlight = (async () => {
		lookupStatus.syncing = true;
		lookupStatus.error = null;
		const failed: Entity[] = [];
		const why: string[] = [];
		for (const e of only) {
			try {
				await storeRows(e, await fetchAll(SPECS[e]));
			} catch (err: any) {
				failed.push(e);
				why.push(`${SPECS[e].collection}${err?.response?.status ? ` (${err.response.status})` : ''}`);
			}
		}
		// Entities outside `only` keep whatever failed state they already had.
		failedEntities = [...failedEntities.filter((e) => !only.includes(e)), ...failed];
		if (!failedEntities.length) {
			lookupStatus.syncedAt = Date.now();
			try { await kv().set('meta', { syncedAt: lookupStatus.syncedAt, counts: { ...lookupStatus.counts } }); } catch { /* ignore */ }
		}
		lookupStatus.error = failedEntities.length
			? `could not refresh: ${why.length ? why.join(', ') : failedEntities.map((e) => SPECS[e].collection).join(', ')}`
			: null;
	})().finally(() => { lookupStatus.syncing = false; inFlight = null; });
	return inFlight;
}

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
const isStale = () => !lookupStatus.syncedAt || Date.now() - lookupStatus.syncedAt > STALE_AFTER_MS;

// One tick of the background refresh: retry just what failed, else refresh everything once stale.
function refreshIfNeeded(): void {
	if (!hasServerSession()) return;
	if (failedEntities.length) void syncLookups(failedEntities.slice());
	else if (isStale()) void syncLookups();
}

/**
 * Keep the snapshot fresh: once shortly after a server session appears (app start, sign-in, or an
 * offline session upgraded by re-signing in), when the network returns, and on a slow timer.
 */
let started = false;
export function startLookupSync(): void {
	if (started) return;
	started = true;
	void loadLookupStatus().then(refreshIfNeeded);
	window.addEventListener('online', refreshIfNeeded);
	setInterval(refreshIfNeeded, 30 * 60 * 1000);
	// A fresh sign-in (or an offline session upgraded by re-signing in) creates a server session after
	// this ran: refresh as soon as one appears.
	watch(() => hasServerSession(), (now) => { if (now) void syncLookups(); });
}

// True when a search should skip the network: nothing to authenticate with, or the OS says offline.
export function preferCache(): boolean {
	return authStore.state.offline || (typeof navigator !== 'undefined' && navigator.onLine === false);
}
