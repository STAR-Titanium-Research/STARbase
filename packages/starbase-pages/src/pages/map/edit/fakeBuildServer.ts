// d1-build in a box, for the tests of edit mode (not imported by production code): drafts in memory with the routes edit mode
// calls, the reference data the Add menu reads, a table of samples, and a log of the calls.

import type { DraftBody, DraftRecord, HostApi } from '@d1/ui';
import { emptyBody } from './draft';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { errors: [{ message: `HTTP ${status}` }] } } });

export const FAKE_METHODS = [
	{ method_id: 'm-turn', method_name: 'Turning', method_code: 'MC', process_category: 'machining' },
	{ method_id: 'm-fast', method_name: 'FAST sintering', method_code: 'MF', process_category: 'sintering' },
	{ method_id: 'm-ht', method_name: 'Heat treatment', method_code: 'HT', process_category: 'heat_treatment' },
];

export const FAKE_SAMPLES = [
	{ sample_id: 's1', sample_code: 'PS-001', form: 'disc', current_status: 'active', version: 4, material_id: { material_id: 'mat1', common_name: 'Titanium', alloy_code: 'Ti64' }, project_id: { project_id: 'proj1' }, mass_grams: 12 },
	{ sample_id: 's2', sample_code: 'PS-002', form: 'rod', current_status: 'active', version: 2, material_id: null, project_id: null },
];

export function fakeServer() {
	const drafts = new Map<string, DraftRecord>();
	const calls: string[] = [];
	const s = {
		drafts,
		calls,
		listStatus: 200,
		seed(id: string, body: DraftBody = emptyBody(), name = 'Seeded') {
			drafts.set(id, { id, name, body, version: 1, updated_at: '2026-10-14T10:00:00Z' });
		},
	};
	let n = 0;
	const idOf = (path: string) => decodeURIComponent(path.split('/')[3]);
	const api = {
		get: async (path: string, config?: { params?: Record<string, unknown> }) => {
			calls.push(`GET ${path}`);
			if (path === '/d1-build/drafts') {
				if (s.listStatus !== 200) throw httpError(s.listStatus);
				return { data: { data: [...drafts.values()].map((d) => ({ id: d.id, name: d.name, updated_at: d.updated_at, summary: 'x' })) } };
			}
			if (path.startsWith('/d1-build/drafts/')) {
				const d = drafts.get(idOf(path));
				if (!d) throw httpError(404);
				return { data: { data: d } };
			}
			if (path === '/items/manufacturing_methods') return { data: { data: FAKE_METHODS } };
			if (path === '/items/physical_samples') {
				const filter = typeof config?.params?.filter === 'string' ? JSON.parse(config.params.filter) : {};
				const ids: string[] | undefined = filter?.sample_id?._in;
				const code: string | undefined = filter?._or?.[0]?.sample_code?._icontains;
				let rows = FAKE_SAMPLES;
				if (ids) rows = rows.filter((r) => ids.includes(r.sample_id));
				if (code) rows = rows.filter((r) => r.sample_code.toLowerCase().includes(code.toLowerCase()));
				return { data: { data: rows } };
			}
			return { data: { data: [] } };
		},
		post: async (path: string, body?: { name: string; body: DraftBody }) => {
			calls.push(`POST ${path}`);
			if (path === '/d1-build/drafts') {
				n += 1;
				const rec: DraftRecord = { id: `d${n}`, name: body!.name, body: body!.body, version: 1, updated_at: 'now' };
				drafts.set(rec.id, rec);
				return { data: { data: rec } };
			}
			if (path.endsWith('/check')) return { data: { data: { checks: [] } } };
			throw httpError(404);
		},
		patch: async (path: string, body?: { body?: DraftBody; name?: string }) => {
			calls.push(`PATCH ${path}`);
			const d = drafts.get(idOf(path));
			if (!d) throw httpError(404);
			const next: DraftRecord = { ...d, body: body?.body ?? d.body, name: body?.name ?? d.name, version: d.version + 1 };
			drafts.set(d.id, next);
			return { data: { data: next } };
		},
		delete: async (path: string) => {
			calls.push(`DELETE ${path}`);
			drafts.delete(idOf(path));
			return { data: {} };
		},
	} as unknown as HostApi;
	return { s, api };
}

/** Lets promises, timers of zero and a render settle. */
export const settle = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
