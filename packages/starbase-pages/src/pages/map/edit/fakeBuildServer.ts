// d1-build in a box, for the tests of edit mode (not imported by production code): drafts in memory with the routes edit mode
// calls, the reference data the add search reads, a table of samples, and a log of the calls.

import type { DraftBody, DraftRecord, HostApi, TemplateRecord } from '@d1/ui';
import { emptyBody } from './draft';

export const httpError = (status: number, extensions?: Record<string, unknown>) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { errors: [{ message: `HTTP ${status}`, ...(extensions ? { extensions } : {}) }] } } });

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
		/** A non-zero status makes every save (PATCH) fail with it (a network error when -1). */
		patchStatus: 0,
		/** When set, starting a draft (POST) waits for it. */
		postGate: null as Promise<void> | null,
		/** What Create and Mark done answer: a body, or an error to throw. */
		createAnswer: { data: { created: { n1: { collection: 'physical_samples', id: 'new1', code: '1-Ti64-MC' } }, sampleIds: ['new1'] } } as unknown,
		markAnswer: null as unknown,
		/** Rows `GET /items/manufacturing_operations` and `/items/test_sessions` answer (what an existing record's read returns). */
		rows: {} as Record<string, Record<string, unknown>[]>,
		/** What `GET /items/projects` and `/items/campaigns` answer (the draft's project and campaign chooser). */
		projects: [
			{ project_id: 'proj1', project_code: 'P-1', project_name: 'Alpha' },
			{ project_id: 'proj2', project_code: 'P-2', project_name: 'Beta' },
		] as Record<string, unknown>[],
		campaigns: [
			{ campaign_id: 'camp1', campaign_code: 'C-1', name: 'Trial 1', project_id: 'proj1' },
			{ campaign_id: 'camp2', campaign_code: 'C-2', name: 'Trial 2', project_id: 'proj2' },
		] as Record<string, unknown>[],
		/** What Back to planned answers: a body, or an error to throw. */
		plannedAnswer: null as unknown,
		bodies: [] as unknown[],
		/** The templates `/d1-build/templates` holds (all visible to the one person who asks). */
		templates: [] as TemplateRecord[],
		/** A non-zero status makes every call of `/d1-build/templates` fail with it (a network error when -1). */
		templateStatus: 0,
		/** The person who asks: templates they made are theirs to change, others' are not (403), as d1-build says. */
		me: 'u1',
		/** Rows `GET /items/equipment`, `/items/tools` and `/items/insert_edges` answer (the state of gear a template names). */
		gear: {} as Record<string, Record<string, unknown>[]>,
		/** Records the caller may read but not change (`GET /permissions/me/...` says update access is false), and a failing answer. */
		readOnly: [] as string[],
		permissionError: false,
		seed(id: string, body: DraftBody = emptyBody(), name = 'Seeded') {
			drafts.set(id, { id, name, body, version: 1, updated_at: '2026-10-14T10:00:00Z' });
		},
	};
	let n = 0;
	const idOf = (path: string) => decodeURIComponent(path.split('/')[3]);
	const templateGate = () => {
		if (s.templateStatus === -1) throw new Error('Network Error');
		if (s.templateStatus) throw httpError(s.templateStatus);
	};
	const templateById = (path: string) => {
		const t = s.templates.find((x) => x.id === idOf(path));
		if (!t) throw httpError(404);
		return t;
	};
	const GEAR_KEY: Record<string, string> = { equipment: 'equipment_id', tools: 'tool_id', insert_edges: 'edge_id' };
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
			if (path === '/d1-build/templates') {
				templateGate();
				return { data: { data: s.templates.map((t) => ({ ...t })) } };
			}
			if (path.startsWith('/items/') && GEAR_KEY[path.slice(7)]) {
				const key = GEAR_KEY[path.slice(7)];
				const filter = typeof config?.params?.filter === 'string' ? JSON.parse(config.params.filter) : {};
				const ids: string[] | undefined = filter?.[key]?._in;
				return { data: { data: (s.gear[path.slice(7)] ?? []).filter((r) => !ids || ids.includes(String(r[key]))) } };
			}
			if (path.startsWith('/permissions/me/')) {
				// What the caller may do with one record (Directus: `data.update.access`): everything unless a test says `readOnly` for that record.
				const id = decodeURIComponent(path.split('/')[4] ?? '');
				if (s.permissionError) throw httpError(500);
				return { data: { data: { update: { access: !s.readOnly.includes(id) }, delete: { access: !s.readOnly.includes(id) }, share: { access: false } } } };
			}
			if (path === '/items/manufacturing_methods') return { data: { data: FAKE_METHODS } };
			if (path === '/items/projects') return { data: { data: s.projects } };
			if (path === '/items/campaigns') return { data: { data: s.campaigns } };
			if (path === '/items/physical_samples') {
				const filter = typeof config?.params?.filter === 'string' ? JSON.parse(config.params.filter) : {};
				const ids: string[] | undefined = filter?.sample_id?._in;
				const code: string | undefined = filter?._or?.[0]?.sample_code?._icontains;
				let rows = FAKE_SAMPLES;
				if (ids) rows = rows.filter((r) => ids.includes(r.sample_id));
				if (code) rows = rows.filter((r) => r.sample_code.toLowerCase().includes(code.toLowerCase()));
				return { data: { data: rows } };
			}
			if (path === '/items/manufacturing_operations' || path === '/items/test_sessions') {
				const filter = typeof config?.params?.filter === 'string' ? JSON.parse(config.params.filter) : {};
				const key = path === '/items/test_sessions' ? 'session_id' : 'operation_id';
				const ids: string[] | undefined = filter?.[key]?._in;
				let rows = (s.rows[path.slice('/items/'.length)] ?? []).filter((r) => !ids || ids.includes(String(r[key])));
				// The picker's search (attachModel.ts): no input sample, every word in the pass code, the method name or the output sample's code.
				const and: Record<string, any>[] | undefined = filter?._and;
				const makes: string[] | undefined = and?.find((c) => c.output_sample_id?._in)?.output_sample_id._in;
				if (makes) {
					// The picker's "which of these already come from another sample": operations that make them from an input.
					rows = rows.filter((r) => makes.includes(String(r.output_sample_id)) && r.sample_id !== null && r.sample_id !== undefined);
				} else if (and) {
					const lower = (v: unknown) => String((v as { method_name?: string; sample_code?: string } | null)?.method_name ?? (v as { sample_code?: string } | null)?.sample_code ?? v ?? '').toLowerCase();
					rows = rows.filter((r) =>
						and.every((c) =>
							c.sample_id?._null
								? r.sample_id === null || r.sample_id === undefined
								: !c._or || c._or.some((o: Record<string, any>) => String(r.pass_code ?? '').toLowerCase().includes(String(o.pass_code?._icontains ?? '\u0000').toLowerCase()) || lower(r.method_id).includes(String(o.method_id?.method_name?._icontains ?? '\u0000').toLowerCase()) || lower(r.output_sample_id).includes(String(o.output_sample_id?.sample_code?._icontains ?? '\u0000').toLowerCase())),
						),
					);
					const offset = Number(config?.params?.offset ?? 0);
					const limit = Number(config?.params?.limit ?? rows.length);
					rows = limit < 0 ? rows.slice(offset) : rows.slice(offset, offset + limit);
				}
				return { data: { data: rows } };
			}
			return { data: { data: [] } };
		},
		post: async (path: string, body?: { name: string; body: DraftBody } | Record<string, unknown>) => {
			calls.push(`POST ${path}`);
			if (path === '/d1-build/drafts') {
				if (s.postGate) await s.postGate;
				n += 1;
				const b = body as { name: string; body: DraftBody };
				const rec: DraftRecord = { id: `d${n}`, name: b.name, body: b.body, version: 1, updated_at: 'now' };
				drafts.set(rec.id, rec);
				return { data: { data: rec } };
			}
			if (path === '/d1-build/templates') {
				templateGate();
				const b = body as Pick<TemplateRecord, 'name' | 'scope' | 'collection' | 'values'>;
				n += 1;
				const t: TemplateRecord = { id: `tn${n}`, name: b.name, scope: b.scope ?? 'private', role_id: b.scope === 'role' ? 'role1' : null, collection: b.collection, values: b.values, user_id: s.me, updated_at: 'now', version: 1 };
				s.templates.push(t);
				return { data: { data: { ...t } } };
			}
			if (path.endsWith('/check')) return { data: { data: { checks: [] } } };
			if (path.endsWith('/create')) {
				if (s.createAnswer instanceof Error) throw s.createAnswer;
				drafts.delete(idOf(path));
				return { data: s.createAnswer };
			}
			if (path === '/d1-build/mark-done') {
				s.bodies.push(body);
				if (s.markAnswer instanceof Error) throw s.markAnswer;
				return { data: s.markAnswer ?? { data: { ids: (body as { ids?: string[] } | undefined)?.ids ?? [], work_state: 'done' } } };
			}
			if (path === '/d1-build/mark-planned') {
				s.bodies.push(body);
				if (s.plannedAnswer instanceof Error) throw s.plannedAnswer;
				return { data: s.plannedAnswer ?? { data: { ids: (body as { ids?: string[] } | undefined)?.ids ?? [], work_state: 'planned' } } };
			}
			throw httpError(404);
		},
		patch: async (path: string, body?: { body?: DraftBody; name?: string }) => {
			calls.push(`PATCH ${path}`);
			if (path.startsWith('/d1-build/templates/')) {
				templateGate();
				const t = templateById(path);
				const b = body as unknown as Partial<TemplateRecord> & { version: number };
				if (t.user_id !== s.me) throw httpError(403);
				if (b.version !== t.version) throw httpError(409);
				Object.assign(t, { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.scope ? { scope: b.scope, role_id: b.scope === 'role' ? 'role1' : null } : {}), ...(b.values ? { values: b.values } : {}), version: t.version + 1 });
				return { data: { data: { ...t } } };
			}
			if (s.patchStatus === -1) throw new Error('Network Error');
			if (s.patchStatus) throw httpError(s.patchStatus);
			const d = drafts.get(idOf(path));
			if (!d) throw httpError(404);
			const next: DraftRecord = { ...d, body: body?.body ?? d.body, name: body?.name ?? d.name, version: d.version + 1 };
			drafts.set(d.id, next);
			return { data: { data: next } };
		},
		delete: async (path: string) => {
			calls.push(`DELETE ${path}`);
			if (path.startsWith('/d1-build/templates/')) {
				templateGate();
				const t = templateById(path);
				if (t.user_id !== s.me) throw httpError(403);
				s.templates = s.templates.filter((x) => x !== t);
				return { data: {} };
			}
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
