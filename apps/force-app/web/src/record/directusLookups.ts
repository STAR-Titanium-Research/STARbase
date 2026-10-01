// Directus-backed typeahead lookups for the Metadata pickers. Small, focused reads over the SPA's
// authenticated `api` client. Each returns [{ id, label, extra? }].
import { api } from '../directusClient';
import { labamp } from './labampApi';
import { SPECS, cachedRows, preferCache, storeRows, type Entity } from './lookupCache';
import { isUnreachable } from '../netErrors';

export interface LookupItem { id: string; label: string; sublabel?: string; extra?: Record<string, any>; }

// Online first; if the server can't be reached (or this is an offline session with no token) fall
// back to the snapshot lookupCache.ts keeps. With no snapshot yet, the original error stands, so
// the picker shows what it always showed.
async function viaCache<T>(entity: Entity, online: () => Promise<T>, offline: (rows: any[]) => T): Promise<T> {
	const fromCache = async (cause: unknown): Promise<T> => {
		const rows = await cachedRows(entity);
		if (rows) return offline(rows);
		throw cause instanceof Error ? cause : new Error('offline, and no offline data has been downloaded yet (connect once and sign in)');
	};
	if (preferCache()) return fromCache(null);
	try {
		return await online();
	} catch (e: any) {
		if (!isUnreachable(e)) throw e;   // the server answered: a real error
		return fromCache(e);
	}
}
const has = (v: unknown, q: string) => String(v ?? '').toLowerCase().includes(q.toLowerCase());
const byText = (key: string) => (a: any, b: any) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''));

const toSampleItem = (r: any): LookupItem => ({
	id: r.sample_id,
	label: r.sample_code || r.sample_id,
	sublabel: r.nickname || undefined,   // human context, shown under the code in the dropdown
	extra: { diameter_mm: r.diameter_mm, nickname: r.nickname },
});

export async function searchSamples(q: string): Promise<LookupItem[]> {
	return viaCache('samples', async () => {
		// Match either the human-readable code OR the nickname, so a search finds a sample even when its
		// only "code" is a legacy hex id (some imported/rig items have no generated sample_code).
		const filter: any = {};
		if (q?.trim()) filter._or = [{ sample_code: { _icontains: q.trim() } }, { nickname: { _icontains: q.trim() } }];
		const res = await api.get('/items/physical_samples', {
			// Descending code_sort surfaces the numbered human codes (…-AA-MF-…) first and pushes the
			// legacy hex-coded rig/equipment items (code_sort '00000000…') to the bottom of the default list.
			params: { filter, limit: 20, sort: '-code_sort', fields: ['sample_id', 'sample_code', 'diameter_mm', 'nickname'] },
		});
		return (res.data?.data ?? []).map(toSampleItem);
	}, (rows) => {
		const t = q?.trim();
		return rows
			.filter((r) => !t || has(r.sample_code, t) || has(r.nickname, t))
			.sort((a, b) => String(b.code_sort ?? '').localeCompare(String(a.code_sort ?? '')))
			.slice(0, 20).map(toSampleItem);
	});
}

const toOperatorItem = (r: any): LookupItem => ({ id: r.person_id, label: r.full_name || r.person_id });

export async function searchOperators(q: string): Promise<LookupItem[]> {
	return viaCache('people', async () => {
		const filter: any = { is_operator: { _eq: true } };
		if (q?.trim()) filter.full_name = { _icontains: q.trim() };
		const res = await api.get('/items/people', { params: { filter, limit: 20, sort: 'full_name', fields: ['person_id', 'full_name'] } });
		return (res.data?.data ?? []).map(toOperatorItem);
	}, (rows) => {
		const t = q?.trim();
		return rows.filter((r) => r.is_operator === true && (!t || has(r.full_name, t)))
			.sort(byText('full_name')).slice(0, 20).map(toOperatorItem);
	});
}

// manufacturing_operations requires a method_id (m2o -> manufacturing_methods). Cache the method
// list and resolve one for a machining/turning run (matching op-type hint, else "Machining").
let methodsCache: LookupItem[] | null = null;
const toMethodItem = (r: any): LookupItem => ({
	id: r.method_id,
	label: r.method_name || '',
	// method_code must be fetched AND carried through to `extra` — resolveMachiningMethodId
	// matches on it, and without it every lookup below silently misses and falls through to
	// the turning default, tagging milling runs with a turning method_id (a NOT NULL FK).
	extra: { method_code: r.method_code || '' },
});
export async function getMethods(): Promise<LookupItem[]> {
	if (methodsCache) return methodsCache;
	// Also persisted for offline use: after a restart with no network the in-memory copy is gone,
	// and without a method_id the run record cannot be built at all. Only a list that came from the
	// server is memoized for the page's life: a snapshot served while offline (possibly old, possibly
	// empty) must not stop the real fetch once the network is back.
	let fromServer = false;
	const items = await viaCache('methods', async () => {
		const res = await api.get('/items/manufacturing_methods', { params: { limit: 100, fields: SPECS.methods.fields } });
		const rows: any[] = res.data?.data ?? [];
		void storeRows('methods', rows).catch(() => {});
		fromServer = true;
		return rows.map(toMethodItem);
	}, (rows) => rows.map(toMethodItem));
	if (fromServer && items.length) methodsCache = items;
	return items;
}
export async function resolveMachiningMethodId(hint?: string): Promise<string | null> {
	const ms = await getMethods();
	// op_type codes are like 'MT-FACE' (turning) / 'MM-SLOT' (milling); the prefix IS the method code.
	if (hint) {
		const prefix = hint.split('-')[0].toUpperCase();
		const byCode = ms.find((x) => (x.extra?.method_code || '').toUpperCase() === prefix);
		if (byCode) return byCode.id;
		// Fall back to matching the method name, in case method_code is blank in this instance.
		const wanted = prefix === 'MM' ? 'milling' : prefix === 'MT' ? 'turning' : '';
		if (wanted) {
			const byName = ms.find((x) => x.label.toLowerCase().includes(wanted));
			if (byName) return byName.id;
		}
	}
	const fallback = ms.find((x) => (x.extra?.method_code || '').toUpperCase() === 'MT')
		|| ms.find((x) => x.label.toLowerCase().includes('turning'))
		|| ms.find((x) => x.label.toLowerCase().includes('machining'));
	return fallback?.id ?? ms[0]?.id ?? null;
}

const toInsertItem = (r: any): LookupItem => ({
	id: r.insert_id,
	label: r.insert_code || r.insert_id,
	sublabel: r.insert_type_id?.type_code || undefined,
});

export async function searchInserts(q: string): Promise<LookupItem[]> {
	return viaCache('inserts', async () => {
		const filter: any = { is_depleted: { _eq: false } };
		if (q?.trim()) filter.insert_code = { _icontains: q.trim() };
		const res = await api.get('/items/cutting_inserts', {
			params: { filter, limit: 20, sort: 'insert_code', fields: ['insert_id', 'insert_code', 'insert_number', 'insert_type_id.type_code'] },
		});
		return (res.data?.data ?? []).map(toInsertItem);
	}, (rows) => {
		const t = q?.trim();
		return rows.filter((r) => r.is_depleted === false && (!t || has(r.insert_code, t)))
			.sort(byText('insert_code')).slice(0, 20).map(toInsertItem);
	});
}

const toEdgeItem = (r: any): LookupItem => ({
	id: r.edge_id,
	label: r.edge_code || r.edge_id,
	sublabel: r.edge_identifier || undefined,
	extra: { insertId: r.insert_id?.insert_id || '', insertLabel: r.insert_id?.insert_code || '' },
});

export async function searchEdges(q: string, insertId?: string): Promise<LookupItem[]> {
	return viaCache('edges', async () => {
		const filter: any = { is_used: { _eq: false } };
		if (insertId) filter.insert_id = { _eq: insertId };
		if (q?.trim()) filter.edge_code = { _icontains: q.trim() };
		const res = await api.get('/items/insert_edges', {
			params: { filter, limit: 20, sort: 'edge_code',
				// Pull the parent insert alongside each edge so picking an edge directly can auto-fill the
				// Insert field (an edge belongs to exactly one insert) — lets the user skip picking the
				// insert first.
				fields: ['edge_id', 'edge_code', 'edge_identifier', 'insert_id.insert_id', 'insert_id.insert_code'] },
		});
		return (res.data?.data ?? []).map(toEdgeItem);
	}, (rows) => {
		const t = q?.trim();
		return rows.filter((r) => r.is_used === false && (!insertId || r.insert_id?.insert_id === insertId) && (!t || has(r.edge_code, t)))
			.sort(byText('edge_code')).slice(0, 20).map(toEdgeItem);
	});
}

// Auto Range "previous run" picker: past operations to use as a reference for the per-channel
// peak forces (converge.ts / labamp.converge). Two sources:
//  - local captures still on this recorder's disk (summary.json's channels_ranging.peaks_n) —
//    the real, per-channel numbers, exact.
//  - Directus machining_force_analysis rows for operations already uploaded elsewhere — only the
//    3 summed-axis peaks exist there (peak_fx/fy/fz), so the per-channel split is APPROXIMATED by
//    dividing each axis peak evenly across its sub-channels, matching the same convention
//    SimSource/finalize.py use (Fx -> 2 channels, Fy -> 2 channels, Fz -> 4 channels). Flagged via
//    `extra.exact` so the UI can tell the user which numbers are real vs estimated.
function approximateChannelPeaks(peakFx: number, peakFy: number, peakFz: number): number[] {
	const fx = peakFx / 2, fy = peakFy / 2, fz = peakFz / 4;
	return [fx, fx, fy, fy, fz, fz, fz, fz]; // Fx1,Fx2,Fy1,Fy2,Fz1,Fz2,Fz3,Fz4
}

export async function searchPastOperations(q: string): Promise<LookupItem[]> {
	const query = q?.trim() || '';
	const [local, db] = await Promise.all([
		labamp.recentCaptures(15, query).then((r) => r.captures).catch(() => []),
		(async () => {
			const filter: any = { status: { _eq: 'done' } };
			if (query) {
				filter._or = [
					{ operation_id: { pass_code: { _icontains: query } } },
					{ operation_id: { sample_id: { sample_code: { _icontains: query } } } },
					{ operation_id: { sample_id: { nickname: { _icontains: query } } } },
				];
			}
			try {
				const res = await api.get('/items/machining_force_analysis', {
					params: {
						filter, limit: 15, sort: '-created_at',
						fields: ['id', 'peak_fx', 'peak_fy', 'peak_fz', 'operation_id.pass_code',
							'operation_id.sample_id.sample_code', 'operation_id.sample_id.nickname'],
					},
				});
				return res.data?.data ?? [];
			} catch { return []; }
		})(),
	]);

	const localItems: LookupItem[] = local.map((c) => ({
		id: `local:${c.id}`,
		label: c.sample_name,
		sublabel: `${c.id} · local, exact`,
		extra: { peaksN: c.peaks_n, exact: true },
	}));

	const dbItems: LookupItem[] = db
		.filter((r: any) => r.peak_fx != null || r.peak_fy != null || r.peak_fz != null)
		.map((r: any) => ({
			id: `db:${r.id}`,
			label: r.operation_id?.pass_code || r.operation_id?.sample_id?.sample_code || r.operation_id?.sample_id?.nickname || r.id,
			sublabel: 'database, approximate',
			extra: { peaksN: approximateChannelPeaks(Number(r.peak_fx) || 0, Number(r.peak_fy) || 0, Number(r.peak_fz) || 0), exact: false },
		}));

	// Exact (local) results first — most useful/reliable data up top.
	return [...localItems, ...dbItems];
}

// `equipment.equipment_type` is free text with real values checked against the live data (not
// assumed) — there is NO turning-vs-milling distinction available: the actual CNC machines here
// (a mix of lathes and mill-turn centres, e.g. "NLX-2500 | 700", "DMU 60 Monoblock") all share the
// single type "Machining", and a naive 'mill' keyword match would wrongly pull in "Attrition Mill"
// — a powder-processing device, not a milling machine. So this can only filter to "is this
// machining-relevant equipment at all" (excludes the ~190 SEM/TEM/furnace/printer/etc rows that
// are never going to be the machine for a force-recorded cut) — it can't split turning from
// milling the way the Tool filter genuinely can (tools.tool_type IS a clean "Turning"/"Milling").
const MACHINING_EQUIPMENT_TYPE = 'Machining';

export async function searchEquipment(q: string, category?: string | null): Promise<LookupItem[]> {
	return viaCache('equipment', () => searchEquipmentOnline(q, category), (rows) => {
		const t = q?.trim();
		const active = rows.filter((r) => r.is_active === true && (!t || has(r.equipment_name, t)))
			.sort(byText('equipment_name'));
		const machining = category ? active.filter((r) => r.equipment_type === MACHINING_EQUIPMENT_TYPE) : [];
		if (machining.length) return machining.slice(0, 20).map(toEquipmentItem);
		return active.slice(0, 20).map((r) => ({ ...toEquipmentItem(r), extra: { ...toEquipmentItem(r).extra, categoryFallback: !!category } }));
	});
}
async function searchEquipmentOnline(q: string, category?: string | null): Promise<LookupItem[]> {
	const filter: any = { is_active: { _eq: true } };
	if (q?.trim()) filter.equipment_name = { _icontains: q.trim() };
	const fields = ['equipment_id', 'equipment_name', 'equipment_code', 'equipment_type'];
	if (category) {
		const res = await api.get('/items/equipment', {
			params: { filter: { ...filter, equipment_type: { _eq: MACHINING_EQUIPMENT_TYPE } }, limit: 20, sort: 'equipment_name', fields },
		});
		const rows = res.data?.data ?? [];
		if (rows.length) return rows.map(toEquipmentItem);
		// No equipment tagged "Machining" matched (or none exist yet) — fall back to the unfiltered
		// set rather than a dead-end "no matches" for a machine that might still be findable by name.
	}
	const res = await api.get('/items/equipment', { params: { filter, limit: 20, sort: 'equipment_name', fields } });
	return (res.data?.data ?? []).map((r: any) => ({ ...toEquipmentItem(r), extra: { ...toEquipmentItem(r).extra, categoryFallback: !!category } }));
}
function toEquipmentItem(r: any): LookupItem {
	return { id: r.equipment_id, label: r.equipment_name || r.equipment_code || r.equipment_id, extra: { type: r.equipment_type } };
}

export async function searchTools(q: string, category?: string | null): Promise<LookupItem[]> {
	return viaCache('tools', () => searchToolsOnline(q, category), (rows) => {
		const t = q?.trim();
		const active = rows.filter((r) => r.is_active === true && (!t || has(r.tool_code, t) || has(r.tool_name, t)))
			.sort(byText('tool_code'));
		const inCategory = category ? active.filter((r) => has(r.tool_type, category)) : active;
		if (inCategory.length || !category) return inCategory.slice(0, 20).map(toToolItem);
		return active.slice(0, 20).map((r) => ({ ...toToolItem(r), extra: { ...toToolItem(r).extra, categoryFallback: true } }));
	});
}
async function searchToolsOnline(q: string, category?: string | null): Promise<LookupItem[]> {
	const filter: any = { is_active: { _eq: true } };
	const clauses: any[] = [];
	if (q?.trim()) clauses.push({ _or: [{ tool_code: { _icontains: q.trim() } }, { tool_name: { _icontains: q.trim() } }] });
	if (category) clauses.push({ tool_type: { _icontains: category } });
	if (clauses.length === 1) Object.assign(filter, clauses[0]);
	else if (clauses.length > 1) filter._and = clauses;
	const fields = ['tool_id', 'tool_code', 'tool_name', 'tool_type'];
	const res = await api.get('/items/tools', { params: { filter, limit: 20, sort: 'tool_code', fields } });
	let rows = res.data?.data ?? [];
	if (!rows.length && category) {
		// Same reasoning as searchEquipment: tool_type is free text, don't let a naming mismatch
		// hide a real tool entirely.
		const fallback = { is_active: { _eq: true } } as any;
		if (q?.trim()) fallback._or = [{ tool_code: { _icontains: q.trim() } }, { tool_name: { _icontains: q.trim() } }];
		const res2 = await api.get('/items/tools', { params: { filter: fallback, limit: 20, sort: 'tool_code', fields } });
		rows = res2.data?.data ?? [];
		return rows.map((r: any) => ({ ...toToolItem(r), extra: { ...toToolItem(r).extra, categoryFallback: true } }));
	}
	return rows.map(toToolItem);
}
function toToolItem(r: any): LookupItem {
	// Show the tool's name as the primary label (more recognisable than the code); keep the code as
	// the sublabel so it's still visible/searchable.
	return {
		id: r.tool_id,
		label: r.tool_name || r.tool_code || r.tool_id,
		sublabel: r.tool_code && r.tool_code !== r.tool_name ? r.tool_code : (r.tool_type || undefined),
		extra: { tool_type: r.tool_type },
	};
}
