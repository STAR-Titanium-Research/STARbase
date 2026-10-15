import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Check, DraftBody, DraftRecord, HostApi } from '@d1/ui';
import type { CheckCtx } from './checks';
import { emptyBody } from './draft';
import { CHANGED_ELSEWHERE, CHECK_DELAY_MS, NETWORK_MESSAGE, SAVE_DELAY_MS, useDraft, type UseDraftOptions } from './useDraft';

interface Call {
	method: 'get' | 'post' | 'patch' | 'delete';
	path: string;
	body?: any;
}

const httpError = (status: number, extensions?: Record<string, unknown>, message = `HTTP ${status}`) =>
	Object.assign(new Error(message), { response: { status, data: { errors: [{ message, ...(extensions ? { extensions } : {}) }] } } });
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

/** A d1-build in a box: drafts in memory with OCC on `version`, and the answers of check / create / mark-done set by the test. */
function fakeServer() {
	const calls: Call[] = [];
	const drafts = new Map<string, DraftRecord>();
	const s = {
		calls,
		drafts,
		listStatus: 200 as number | 'network',
		failPatch: null as unknown,
		checkAnswer: [] as Check[],
		createAnswer: null as unknown,
		markDoneAnswer: null as unknown,
		bump(id: string, body: DraftBody) {
			const d = drafts.get(id)!;
			drafts.set(id, { ...d, body, version: d.version + 1 });
		},
		seed(id: string, body: DraftBody = emptyBody(), name = 'Seeded'): DraftRecord {
			const rec: DraftRecord = { id, name, body, version: 1, updated_at: '2026-10-14T10:00:00Z' };
			drafts.set(id, rec);
			return rec;
		},
	};
	let counter = 0;
	const idOf = (path: string) => decodeURIComponent(path.split('/')[3]);
	const api = {
		get: async (path: string) => {
			calls.push({ method: 'get', path });
			if (path === '/d1-build/drafts') {
				if (s.listStatus === 'network') throw networkError();
				if (s.listStatus !== 200) throw httpError(s.listStatus);
				return { data: { data: [...drafts.values()].map((d) => ({ id: d.id, name: d.name, updated_at: d.updated_at, summary: 'x' })) } };
			}
			const d = drafts.get(idOf(path));
			if (!d) throw httpError(404);
			return { data: { data: d } };
		},
		post: async (path: string, body?: any) => {
			calls.push({ method: 'post', path, body });
			if (path === '/d1-build/drafts') {
				counter += 1;
				const rec: DraftRecord = { id: `d${counter}`, name: body.name, body: body.body, version: 1, updated_at: 'now' };
				drafts.set(rec.id, rec);
				return { data: { data: rec } };
			}
			if (path.endsWith('/check')) return { data: { data: { checks: s.checkAnswer } } };
			if (path.endsWith('/create')) {
				if (s.createAnswer instanceof Error) throw s.createAnswer;
				drafts.delete(idOf(path));
				return { data: s.createAnswer };
			}
			if (path === '/d1-build/mark-done') {
				if (s.markDoneAnswer instanceof Error) throw s.markDoneAnswer;
				return { data: s.markDoneAnswer };
			}
			throw httpError(404);
		},
		patch: async (path: string, body?: any) => {
			calls.push({ method: 'patch', path, body });
			if (s.failPatch) {
				const e = s.failPatch;
				s.failPatch = null;
				throw e;
			}
			const d = drafts.get(idOf(path));
			if (!d) throw httpError(404);
			if (body.version !== d.version) throw httpError(409, { code: 'VERSION' }, 'Version conflict');
			const next: DraftRecord = { ...d, body: body.body ?? d.body, name: body.name ?? d.name, version: d.version + 1 };
			drafts.set(d.id, next);
			return { data: { data: next } };
		},
		delete: async (path: string) => {
			calls.push({ method: 'delete', path });
			if (!drafts.delete(idOf(path))) throw httpError(404);
			return { data: {} };
		},
	} as unknown as HostApi;
	return { s, api };
}

const patches = (calls: Call[]) => calls.filter((c) => c.method === 'patch');
const make = (extra: Partial<UseDraftOptions> = {}) => {
	const server = fakeServer();
	const draft = useDraft({ api: server.api, ...extra });
	return { ...server, draft };
};
const tick = (ms = SAVE_DELAY_MS) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useDraft: is d1-build there', () => {
	it('is available once the list answers, and has my drafts', async () => {
		const { s, draft } = make();
		s.seed('a');
		expect(draft.available.value).toBe(false);
		await draft.probe();
		expect(draft.available.value).toBe(true);
		expect(draft.probed.value).toBe(true);
		expect(draft.drafts.value.map((d) => d.id)).toEqual(['a']);
	});

	it('is not available when the list 404s (STARbase deployed before d1-server), and says nothing about it', async () => {
		const { s, draft } = make();
		s.listStatus = 404;
		expect(await draft.probe()).toBe(false);
		expect(draft.available.value).toBe(false);
		expect(draft.probed.value).toBe(true);
		expect(draft.probeError.value).toBe('');
	});

	it('is not available when the server fails, and keeps the reason', async () => {
		const { s, draft } = make();
		s.listStatus = 500;
		expect(await draft.probe()).toBe(false);
		expect(draft.probeError.value).toBe('HTTP 500');
	});
});

describe('useDraft: keeping the draft', () => {
	it('starts a new draft on the server and holds it', async () => {
		const { s, draft } = make();
		const id = await draft.start({ name: 'Cut plan' });
		expect(id).toBe('d1');
		expect(s.calls[0]).toEqual({ method: 'post', path: '/d1-build/drafts', body: { name: 'Cut plan', body: emptyBody() } });
		expect(draft.draftId.value).toBe('d1');
		expect(draft.name.value).toBe('Cut plan');
		expect(draft.version.value).toBe(1);
	});

	it('names a new draft from its first sample code and the date when no name is given', async () => {
		const { s, draft } = make({ nameFor: () => 'Named by the page' });
		await draft.start();
		expect(s.calls[0].body.name).toBe('Named by the page');
		const plain = make();
		await plain.draft.start();
		expect(plain.s.calls[0].body.name).toMatch(/^New process · \d{4}-\d{2}-\d{2}$/);
	});

	it('saves 800 ms after the last change: one PATCH with the latest body and the version it was read at', async () => {
		const { s, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		await tick(400);
		draft.apply({ type: 'addSample' });
		await tick(400);
		expect(patches(s.calls)).toHaveLength(0);
		expect(draft.saving.value).toBe(true);
		await tick(400);
		const sent = patches(s.calls);
		expect(sent).toHaveLength(1);
		expect(sent[0].path).toBe('/d1-build/drafts/d1');
		expect(sent[0].body.version).toBe(1);
		expect(sent[0].body.body.items.map((i: any) => i.key)).toEqual(['n1', 'n2']);
		expect(sent[0].body).not.toHaveProperty('name');
		expect(draft.version.value).toBe(2);
		expect(draft.saving.value).toBe(false);
		// The next change is sent against the new version.
		draft.apply({ type: 'addSample' });
		await tick();
		expect(patches(s.calls)[1].body.version).toBe(2);
		expect(draft.version.value).toBe(3);
	});

	it('an action that changes nothing is no step and no save', async () => {
		const { s, draft } = make();
		await draft.start();
		draft.apply({ type: 'remove', key: 'nope' });
		await tick(2000);
		expect(patches(s.calls)).toHaveLength(0);
		expect(draft.canUndo.value).toBe(false);
	});

	it('a change made while a save is on the wire is sent after it', async () => {
		const { s, api, draft } = make();
		await draft.start();
		let release!: () => void;
		const realPatch = api.patch.bind(api);
		(api as any).patch = async (path: string, body: any, cfg: any) => {
			await new Promise<void>((r) => (release = r));
			return realPatch(path, body, cfg);
		};
		draft.apply({ type: 'addSample' });
		await tick();
		expect(draft.saving.value).toBe(true);
		draft.apply({ type: 'addSample' });
		release();
		await tick(0);
		await tick(SAVE_DELAY_MS);
		release();
		await tick(0);
		expect(s.drafts.get('d1')!.body.items).toHaveLength(2);
		expect(draft.version.value).toBe(3);
	});

	it('the name goes with the next save, and is not an undo step', async () => {
		const { s, draft } = make();
		await draft.start({ name: 'Old' });
		draft.rename('  New name  ');
		await tick();
		expect(patches(s.calls)[0].body.name).toBe('New name');
		expect(draft.name.value).toBe('New name');
		expect(draft.canUndo.value).toBe(false);
		draft.apply({ type: 'addSample' });
		await tick();
		expect(patches(s.calls)[1].body).not.toHaveProperty('name');
	});

	it('flush sends at once', async () => {
		const { s, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		await draft.flush();
		expect(patches(s.calls)).toHaveLength(1);
		expect(draft.saving.value).toBe(false);
	});
});

describe('useDraft: undo and redo', () => {
	it('steps back and forward over the changes, and each step is kept on the server', async () => {
		const { s, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		draft.apply({ type: 'addSample' });
		expect(draft.canUndo.value).toBe(true);
		expect(draft.canRedo.value).toBe(false);
		draft.undo();
		expect(draft.body.value.items).toHaveLength(1);
		expect(draft.canRedo.value).toBe(true);
		draft.redo();
		expect(draft.body.value.items).toHaveLength(2);
		draft.undo();
		draft.undo();
		draft.undo(); // nothing left: no step
		expect(draft.body.value.items).toHaveLength(0);
		expect(draft.canUndo.value).toBe(false);
		await tick();
		expect(patches(s.calls)).toHaveLength(1);
		expect(patches(s.calls)[0].body.body.items).toHaveLength(0);
	});

	it('a new change after undo drops redo', async () => {
		const { draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		draft.undo();
		draft.apply({ type: 'addSample', values: { form: 'bar' } });
		expect(draft.canRedo.value).toBe(false);
	});
});

describe('useDraft: a draft that changed elsewhere (409)', () => {
	it('reloads it, drops the undo history and says so', async () => {
		const { s, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		// Another tab saved first.
		s.bump('d1', { ...emptyBody(), projectId: 'from-the-other-tab' });
		await tick();
		expect(patches(s.calls)).toHaveLength(1);
		expect(draft.notice.value).toBe(CHANGED_ELSEWHERE);
		expect(draft.body.value.projectId).toBe('from-the-other-tab');
		expect(draft.body.value.items).toHaveLength(0);
		expect(draft.canUndo.value).toBe(false);
		expect(draft.version.value).toBe(2);
		expect(draft.saving.value).toBe(false);
		// Editing goes on from there.
		draft.apply({ type: 'addSample' });
		await tick();
		expect(patches(s.calls)[1].body.version).toBe(2);
		expect(s.drafts.get('d1')!.body.projectId).toBe('from-the-other-tab');
	});
});

describe('useDraft: a save that fails', () => {
	it('keeps the change in the page, says so, and sends it again with the next one', async () => {
		const { s, draft } = make();
		await draft.start();
		s.failPatch = networkError();
		draft.apply({ type: 'addSample' });
		await tick();
		expect(draft.saveError.value).toMatch(/Could not reach the server/);
		expect(draft.body.value.items).toHaveLength(1);
		expect(draft.saving.value).toBe(true);
		draft.apply({ type: 'addSample' });
		await tick();
		expect(draft.saveError.value).toBe('');
		expect(s.drafts.get('d1')!.body.items).toHaveLength(2);
		expect(draft.saving.value).toBe(false);
	});

	it('a draft that is gone says so', async () => {
		const { s, draft } = make();
		await draft.start();
		s.drafts.clear();
		draft.apply({ type: 'addSample' });
		await tick();
		expect(draft.saveError.value).toBe('This draft no longer exists on the server.');
	});
});

describe('useDraft: opening a draft and its checks', () => {
	it('reads the draft, then has the server check it, and merges the answer with the client checks', async () => {
		const { s, draft } = make();
		const body: DraftBody = {
			...emptyBody(),
			items: [
				{ key: 'n1', kind: 'sample', existing: { id: 's', version: 1 }, values: {} },
				{ key: 'n2', kind: 'operation', workState: 'planned', values: {}, rows: [{ key: 'n3' }] },
			],
		};
		s.seed('a', body, 'Seeded');
		s.checkAnswer = [
			{ key: 'n1', level: 'warn', code: 'STALE_VERSION', text: 'Changed since you added it. Review it before you create.' },
			{ key: 'gone', level: 'block', code: 'GONE', text: 'a card that is not on the canvas' },
			{ key: 'n2', level: 'block', code: 'OTHER', text: 'Choose a method.' },
		];
		expect(await draft.open('a')).toBe(true);
		expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['get /d1-build/drafts/a', 'post /d1-build/drafts/a/check']);
		expect(draft.name.value).toBe('Seeded');
		const list = draft.checks.value;
		// The client's: the operation has no method and no sample. The server's: the stale warning (the unknown card is dropped).
		expect(list.map((c) => `${c.level}:${c.key}`)).toEqual(['block:n2', 'block:n2', 'warn:n2', 'warn:n2', 'warn:n1']);
		expect(draft.missing.value).toBe(2);
		expect(list.find((c) => c.key === 'n1')?.text).toMatch(/Changed since/);
	});

	it('the client checks follow the body as it changes', async () => {
		const { draft } = make();
		await draft.start();
		expect(draft.checks.value).toEqual([]);
		draft.apply({ type: 'addContainer', kind: 'test', source: { from: 'blank' } });
		expect(draft.missing.value).toBe(2);
		draft.undo();
		expect(draft.missing.value).toBe(0);
	});

	it('a draft that cannot be read says so and leaves the page as it was', async () => {
		const { draft } = make();
		expect(await draft.open('missing')).toBe(false);
		expect(draft.saveError.value).toBe('That draft is not there any more.');
		expect(draft.loading.value).toBe(false);
		expect(draft.draftId.value).toBeNull();
	});

	it('opens a draft only after a waiting save of the one before has been sent', async () => {
		const { s, draft } = make();
		await draft.start();
		s.seed('b');
		draft.apply({ type: 'addSample' });
		await draft.open('b');
		expect(s.drafts.get('d1')!.body.items).toHaveLength(1);
		expect(draft.draftId.value).toBe('b');
	});

	it('the latest open wins when two overlap', async () => {
		const { s, draft } = make();
		s.seed('a');
		s.seed('b');
		const first = draft.open('a');
		const second = draft.open('b');
		await Promise.all([first, second]);
		expect(draft.draftId.value).toBe('b');
	});
});

describe('useDraft: server checks stay true', () => {
	/** A draft with an existing sample n1 and a new operation n2 (row n3) wired from it. */
	const withExisting = (): DraftBody => ({
		...emptyBody(),
		items: [
			{ key: 'n1', kind: 'sample', existing: { id: 's', version: 1 }, values: {} },
			{ key: 'n2', kind: 'operation', workState: 'planned', values: { method_id: 'm' }, rows: [{ key: 'n3' }] },
		],
		wires: [{ from: { key: 'n1' }, to: { key: 'n2', row: 0 } }],
		seq: 3,
	});
	const stale: Check = { key: 'n1', level: 'warn', code: 'STALE_VERSION', text: 'Changed since you added it — review.' };
	const texts = (d: ReturnType<typeof useDraft>) => d.checks.value.map((c) => c.text);

	it('keeps only what the client cannot tell: GONE, NOT_ATTACHABLE, STALE_VERSION, REMOVE_BLOCKED, PERMISSION', async () => {
		const { s, draft } = make();
		s.seed('a', withExisting());
		const codes = ['GONE', 'NOT_ATTACHABLE', 'STALE_VERSION', 'REMOVE_BLOCKED', 'PERMISSION', 'OTHER', undefined];
		s.checkAnswer = codes.map((code, i) => ({ key: 'n1', level: 'warn', ...(code ? { code } : {}), text: `t${i}` }));
		await draft.open('a');
		expect(draft.checks.value.filter((c) => c.key === 'n1').map((c) => c.text)).toEqual(['t0', 't1', 't2', 't3', 't4']);
	});

	it("drops a card's server checks as soon as the card changes", async () => {
		const { s, draft } = make();
		s.seed('a', withExisting());
		s.checkAnswer = [stale, { key: 'n2', level: 'block', code: 'PERMISSION', text: 'You may not.' }];
		await draft.open('a');
		expect(texts(draft)).toContain(stale.text);
		draft.apply({ type: 'setValues', key: 'n1', values: { notes: 'x' } });
		expect(texts(draft)).not.toContain(stale.text);
		expect(texts(draft)).toContain('You may not.');
		// undo changes the card back: still not the card the server read
		draft.undo();
		expect(texts(draft)).not.toContain(stale.text);
	});

	it('drops the server checks of both ends of a wire that comes or goes', async () => {
		const { s, draft } = make();
		s.seed('a', withExisting());
		s.checkAnswer = [stale, { key: 'n2', level: 'block', code: 'PERMISSION', text: 'You may not.' }];
		await draft.open('a');
		draft.apply({ type: 'unwire', from: { key: 'n1' }, to: { key: 'n2', row: 0 } });
		expect(texts(draft)).not.toContain(stale.text);
		expect(texts(draft)).not.toContain('You may not.');
	});

	it('moving a card does not drop them', async () => {
		const { s, draft } = make();
		s.seed('a', withExisting());
		s.checkAnswer = [stale];
		await draft.open('a');
		draft.apply({ type: 'move', key: 'n1', x: 5, y: 5 });
		expect(texts(draft)).toContain(stale.text);
	});

	it('an answer about a card that changed while it was on its way is not kept', async () => {
		const { s, api, draft } = make();
		s.seed('a', withExisting());
		await draft.open('a');
		const real = api.post.bind(api);
		let release!: () => void;
		(api as any).post = async (path: string, body: any, cfg: any) => {
			if (path.endsWith('/check')) await new Promise<void>((r) => (release = r));
			return real(path, body, cfg);
		};
		s.checkAnswer = [stale];
		const asking = draft.checkNow();
		await tick(0);
		release();
		draft.apply({ type: 'setValues', key: 'n1', values: { notes: 'x' } });
		await asking;
		expect(texts(draft)).not.toContain(stale.text);
	});

	it('checks again 1.5 s after a save when the draft has records that exist, and not when it has none', async () => {
		const { s, draft } = make();
		s.seed('a', withExisting());
		await draft.open('a');
		const checkCalls = () => s.calls.filter((c) => c.path.endsWith('/check')).length;
		expect(checkCalls()).toBe(1);
		draft.apply({ type: 'move', key: 'n1', x: 1, y: 1 });
		await tick(SAVE_DELAY_MS);
		expect(checkCalls()).toBe(1);
		s.checkAnswer = [stale];
		await tick(CHECK_DELAY_MS);
		expect(checkCalls()).toBe(2);
		expect(texts(draft)).toContain(stale.text);
		// Changes in quick succession: one check after the last save.
		draft.apply({ type: 'move', key: 'n1', x: 2, y: 2 });
		await tick(SAVE_DELAY_MS);
		draft.apply({ type: 'move', key: 'n1', x: 3, y: 3 });
		await tick(SAVE_DELAY_MS + CHECK_DELAY_MS);
		expect(checkCalls()).toBe(3);

		const fresh = make();
		await fresh.draft.start();
		fresh.draft.apply({ type: 'addSample' });
		await tick(SAVE_DELAY_MS + CHECK_DELAY_MS * 2);
		expect(fresh.s.calls.some((c) => c.path.endsWith('/check'))).toBe(false);
	});
});

describe('useDraft: a reload that fails, and edits while Create runs', () => {
	it('a failed reload after a conflict shows its error, keeps the changes to send, and rejects nothing', async () => {
		const { s, api, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		s.bump('d1', emptyBody());
		const real = api.get.bind(api);
		(api as any).get = async (path: string, cfg: any) => {
			if (path === '/d1-build/drafts/d1') throw networkError();
			return real(path, cfg);
		};
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		await tick();
		await tick(10);
		process.off('unhandledRejection', unhandled);
		expect(unhandled).not.toHaveBeenCalled();
		expect(draft.saveError.value).toMatch(/Could not reach the server/);
		expect(draft.saving.value).toBe(false);
		expect(draft.body.value.items).toHaveLength(1);
		expect(draft.notice.value).toBe('');
		// The next change tries again, now with a reload that works.
		(api as any).get = real;
		draft.apply({ type: 'addSample' });
		await tick();
		expect(draft.notice.value).toBe(CHANGED_ELSEWHERE);
	});

	it('Create does not go on when the save before it found the draft changed elsewhere', async () => {
		const { s, draft } = make({ ctx: () => ({ alloyCode: () => 'A', methodCode: () => 'B' }) });
		await draft.start();
		draft.apply({ type: 'addSample', values: { material_id: 'm', primary_method_id: 'p' } });
		s.bump('d1', { ...emptyBody(), projectId: 'elsewhere' });
		const out = await draft.create();
		expect(out).toEqual({ ok: false, reason: 'conflict', message: CHANGED_ELSEWHERE });
		expect(s.calls.some((c) => c.path.endsWith('/create'))).toBe(false);
		expect(draft.body.value.projectId).toBe('elsewhere');
		expect(draft.draftId.value).toBe('d1');
	});

	it('apply, undo and redo do nothing while Create is running, and nothing is saved after it', async () => {
		const { s, api, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		draft.apply({ type: 'addSample' });
		draft.undo();
		await draft.flush();
		let release!: () => void;
		const real = api.post.bind(api);
		(api as any).post = async (path: string, body: any, cfg: any) => {
			if (path.endsWith('/create')) await new Promise<void>((r) => (release = r));
			return real(path, body, cfg);
		};
		s.createAnswer = { data: { created: {}, sampleIds: [] } };
		const creating = draft.create();
		await tick(0);
		expect(draft.creating.value).toBe(true);
		const before = draft.body.value;
		expect(draft.apply({ type: 'addSample' })).toBe(before);
		draft.redo();
		draft.undo();
		expect(draft.body.value).toBe(before);
		release();
		expect((await creating).ok).toBe(true);
		const sent = patches(s.calls).length;
		await tick(5000);
		expect(patches(s.calls)).toHaveLength(sent);
	});
});

describe('useDraft: Create', () => {
	const CODE_CTX: () => CheckCtx = () => ({ alloyCode: (m) => ({ ti: 'Ti64' })[m], methodCode: (m) => ({ mc: 'MC' })[m], today: new Date(2026, 9, 14, 12) });

	/** A new sample with a material and a method: complete but for its code. */
	async function ready(extra: Partial<UseDraftOptions> = {}) {
		const t = make({ ctx: CODE_CTX, ...extra });
		await t.draft.start();
		t.draft.apply({ type: 'addSample', values: { material_id: 'ti', primary_method_id: 'mc' } });
		return t;
	}

	it('composes the sample codes, keeps the draft, creates it, and hands back what was made', async () => {
		const { s, draft } = await ready();
		s.createAnswer = { data: { created: { n1: { collection: 'physical_samples', id: 'uuid-1', code: '57-Ti64-MC-2026-10-14' } }, sampleIds: ['uuid-1'] } };
		const out = await draft.create();
		expect(out).toEqual({ ok: true, created: { n1: { collection: 'physical_samples', id: 'uuid-1', code: '57-Ti64-MC-2026-10-14' } }, sampleIds: ['uuid-1'] });
		const order = s.calls.map((c) => `${c.method} ${c.path}`);
		expect(order.slice(-3)).toEqual(['patch /d1-build/drafts/d1', 'post /d1-build/drafts/d1/create', 'get /d1-build/drafts']);
		expect(patches(s.calls)[0].body.body.items[0].values.sample_code).toBe('{seq}-Ti64-MC-2026-10-14');
		// The draft is gone, the history cleared: undo cannot reach the records.
		expect(draft.draftId.value).toBeNull();
		expect(draft.canUndo.value).toBe(false);
		expect(draft.body.value.items).toEqual([]);
		expect(draft.creating.value).toBe(false);
	});

	it('is refused with the checks that stop it: the draft stays and Checks shows them', async () => {
		const { s, draft } = await ready();
		const stop: Check = { key: 'n1', level: 'block', text: 'This sample is gone, or you can no longer see it. Take it off the canvas.' };
		s.createAnswer = httpError(409, { code: 'CHECKS', checks: [stop] }, 'Something is missing');
		const out = await draft.create();
		expect(out).toEqual({ ok: false, reason: 'checks', checks: [stop], message: 'Something is missing' });
		expect(draft.draftId.value).toBe('d1');
		expect(draft.body.value.items).toHaveLength(1);
		expect(draft.checks.value).toContainEqual(stop);
		expect(draft.creating.value).toBe(false);
	});

	it('names the card whose write failed', async () => {
		const { s, draft } = await ready();
		s.createAnswer = httpError(400, { code: 'WRITE_FAILED', key: 'n1' }, 'The database refused this sample');
		expect(await draft.create()).toEqual({ ok: false, reason: 'write', key: 'n1', message: 'The database refused this sample' });
		expect(draft.draftId.value).toBe('d1');
	});

	it('says nothing was created when the server cannot be reached', async () => {
		const { s, draft } = await ready();
		s.createAnswer = networkError();
		expect(await draft.create()).toEqual({ ok: false, reason: 'network', message: NETWORK_MESSAGE });
		expect(draft.draftId.value).toBe('d1');
	});

	it('does not start twice, and has nothing to create without a draft', async () => {
		const { s, draft } = await ready();
		s.createAnswer = { data: { created: {}, sampleIds: [] } };
		const [a, b] = await Promise.all([draft.create(), draft.create()]);
		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		expect(s.calls.filter((c) => c.path.endsWith('/create'))).toHaveLength(1);
		expect((await draft.create()).ok).toBe(false);
	});

	it('does not create when the draft could not be kept first', async () => {
		const { s, draft } = await ready();
		s.failPatch = networkError();
		const out = await draft.create();
		expect(out.ok).toBe(false);
		expect(s.calls.some((c) => c.path.endsWith('/create'))).toBe(false);
	});
});

describe('useDraft: Mark done and discard', () => {
	it('marks a record done with no draft open', async () => {
		const { s, draft } = make();
		s.markDoneAnswer = { data: { id: 'op-1', work_state: 'done' } };
		const input = { collection: 'manufacturing_operations', id: 'op-1', date: '2026-10-14' } as const;
		expect(await draft.markDone(input)).toEqual({ ok: true, id: 'op-1', work_state: 'done' });
		expect(s.calls[0]).toEqual({ method: 'post', path: '/d1-build/mark-done', body: input });
	});

	it('is refused with the checks that stop it', async () => {
		const { s, draft } = make();
		const check: Check = { key: 'op-1', field: 'feed_rate', level: 'block', text: 'Fill in Feed rate: a done operation needs it.' };
		s.markDoneAnswer = httpError(409, { code: 'CHECKS', checks: [check] }, 'Missing');
		expect(await draft.markDone({ collection: 'manufacturing_operations', id: 'op-1' })).toEqual({ ok: false, reason: 'checks', checks: [check], message: 'Missing' });
	});

	it('a refusal that is not about checks keeps its message', async () => {
		const { s, draft } = make();
		s.markDoneAnswer = httpError(403, undefined, 'You may not');
		expect(await draft.markDone({ collection: 'test_sessions', id: 't' })).toEqual({ ok: false, reason: 'error', message: 'You may not' });
		s.markDoneAnswer = networkError();
		expect((await draft.markDone({ collection: 'test_sessions', id: 't' })).ok).toBe(false);
	});

	it('discards the draft and lets go of it', async () => {
		const { s, draft } = make();
		await draft.start();
		draft.apply({ type: 'addSample' });
		expect(await draft.discard()).toBe(true);
		expect(s.drafts.size).toBe(0);
		expect(draft.draftId.value).toBeNull();
		await tick(2000);
		expect(patches(s.calls)).toHaveLength(0); // the waiting save was dropped with it
	});
});
