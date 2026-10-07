import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

// createWorkspace() start/stop/upload paths (stream-2 review 2.1, 2.2, 2.5, 2.7). Everything the
// workspace talks to (Directus, the recorder, dialogs) is faked at the module boundary.

const dx = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock('../directusClient', () => ({
	api: { post: (...a: unknown[]) => dx.post(...a), get: (...a: unknown[]) => dx.get(...a), patch: (...a: unknown[]) => dx.patch(...a) },
	authHeaders: () => ({}),
}));
const auth = vi.hoisted(() => ({
	state: { user: { id: 'u1', email: 'a@b.c' } as any, offline: false, accessToken: 'at' as string | null, refreshToken: 'rt' as string | null },
}));
vi.mock('../authStore', () => ({ authStore: auth }));
vi.mock('@d1/force-plotting', () => ({
	buildSeriesEnvelope: vi.fn(() => ({ series: true })),
	// Holds the last pushed value until flush() (the 250 ms timer is not simulated): enough to
	// drive the "flushed on page hide" path in the setup-persistence tests below.
	debouncePublish: <T,>(publish: (v: T) => void) => {
		let pending: { v: T } | null = null;
		return {
			push: (v: T) => { pending = { v }; },
			flush: () => { if (pending) { const { v } = pending; pending = null; publish(v); } },
			cancel: () => { pending = null; },
		};
	},
	parseCache: vi.fn(() => ({ csSec: 0, ceSec: 1 })),
}));
vi.mock('./directusLookups', () => ({
	searchSamples: vi.fn(), searchOperators: vi.fn(), searchEquipment: vi.fn(), searchTools: vi.fn(),
	searchInserts: vi.fn(), searchEdges: vi.fn(),
	getMethods: vi.fn().mockResolvedValue([]),
	resolveMachiningMethodId: vi.fn().mockResolvedValue('method-1'),
}));
vi.mock('./directusSync', () => ({ logRun: vi.fn(), syncStatus: {} }));
const labampMock = vi.hoisted(() => ({ setMode: vi.fn().mockResolvedValue(undefined), converge: vi.fn(), status: vi.fn() }));
vi.mock('./labampApi', () => ({ labamp: labampMock }));
const confirmMock = vi.hoisted(() => ({ confirmAction: vi.fn().mockResolvedValue(true) }));
vi.mock('../ui/confirm', () => confirmMock);
vi.mock('../ui/spotlight', () => ({ spotlight: vi.fn() }));

import { createWorkspace } from './workspace';
import { clearUploadProgress, uploadProgress } from './uploadResume';
import { alarmController } from './alarms';
import { hwStatus } from './hwStatus';

type Reply = { ok?: boolean; status?: number; body?: unknown; text?: string };
let replies: Record<string, Reply | (() => Reply | Promise<Reply>)>;
const calls: string[] = [];

function memoryStorage() {
	const m = new Map<string, string>();
	return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } };
}

beforeEach(() => {
	clearUploadProgress();
	replies = {};
	calls.length = 0;
	dx.post.mockReset(); dx.get.mockReset();
	auth.state.offline = false; auth.state.accessToken = 'at';
	vi.stubGlobal('localStorage', memoryStorage());
	vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
		const path = new URL(url, 'http://x').pathname;
		calls.push(`${init?.method ?? 'GET'} ${path}`);
		const r0 = replies[path];
		const r = (typeof r0 === 'function' ? await r0() : r0) ?? { ok: false, status: 404 };
		return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body, text: async () => r.text ?? '', blob: async () => new Blob(['x']), arrayBuffer: async () => new ArrayBuffer(8) };
	}));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function make() {
	const w = createWorkspace();
	await Promise.resolve();
	return w;
}

describe('workspace.stop() (2.1)', () => {
	it('when the recorder refuses the stop and is still recording: closes the dialog and says so', async () => {
		replies['/record/stop'] = { ok: false, status: 500, text: 'boom' };
		replies['/record/status'] = { body: { state: 'recording', id: 'cap-1' } };
		const w = await make();
		w.st.state = 'recording'; w.st.captureId = 'cap-1';
		await w.stop();
		expect(w.saveOpen.value).toBe(false);
		expect(w.errMsg.value).toMatch(/could not stop the recording.*500/);
		expect(w.busy.value).toBe(false);
	});

	it('409 because the cut already ended on its own: adopts the recorder state and keeps the save dialog', async () => {
		replies['/record/stop'] = { ok: false, status: 409, text: 'not recording' };
		replies['/record/status'] = { body: { state: 'done', id: 'cap-2' } };
		replies['/captures/cap-2/summary'] = { body: { duration_sec: 3 } };
		replies['/captures/cap-2/live_cache.bin'] = { body: null };
		const w = await make();
		w.st.state = 'recording'; w.st.captureId = 'cap-2';
		await w.stop();
		expect(w.st.state).toBe('done');
		expect(w.saveOpen.value).toBe(true);
		expect(w.errMsg.value).toBeNull();
		expect(w.finishedCache.value).not.toBeNull();
	});

	it('an unreachable recorder does not leave the dialog spinning on "recording"', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
		const w = await make();
		w.st.state = 'recording'; w.st.captureId = 'cap-3';
		await w.stop();
		expect(w.saveOpen.value).toBe(false);
		expect(w.errMsg.value).toMatch(/could not stop/);
	});
});

// ---- 2.2: the save retry resumes instead of inserting a second operation row ----
const posts = (url: string) => dx.post.mock.calls.filter((c) => c[0] === url).length;
const netErr = () => Object.assign(new Error('Network Error'), { response: undefined });
const serverErr = () => Object.assign(new Error('Request failed'), { response: { status: 500, data: { errors: [{ message: 'boom' }] } } });

function okReplies() {
	replies['/captures/cap-up/capture.mat'] = { body: null };
	replies['/captures/cap-up/live_cache.bin'] = { body: null };
}
async function uploadable() {
	const w = await make();
	w.st.state = 'done'; w.st.captureId = 'cap-up'; w.st.summary = { mat_written: true, peaks: { Fx: 1, Fy: 2, Fz: 3 } };
	w.link.sampleId = 'sample-1';
	return w;
}
let fileN = 0;

describe('workspace.uploadCutToDatabase() resume (2.2)', () => {
	beforeEach(() => { okReplies(); fileN = 0; dx.get.mockResolvedValue({ data: { data: [] } }); });

	it('a failed analysis insert does not insert the operation or upload the files again', async () => {
		let analysisFails = true;
		dx.post.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: { operation_id: 'op-1' } } };
			if (url === '/files') return { data: { data: { id: `file-${++fileN}` } } };
			if (url === '/items/machining_force_analysis') { if (analysisFails) throw serverErr(); return { data: { data: {} } }; }
			throw new Error(url);
		});
		const w = await uploadable();
		await expect(w.uploadCutToDatabase()).rejects.toThrow(/linking the capture failed/);
		analysisFails = false;
		await expect(w.uploadCutToDatabase()).resolves.toBe('op-1');
		expect(posts('/items/manufacturing_operations')).toBe(1);
		expect(posts('/files')).toBe(2);
		expect(posts('/items/machining_force_analysis')).toBe(2);
		// and a third call (a double click on Save) is a no-op returning the same row
		await expect(w.uploadCutToDatabase()).resolves.toBe('op-1');
		expect(posts('/items/machining_force_analysis')).toBe(2);
	});

	it('a failed file upload keeps the operation id and the file that did land', async () => {
		let cacheFails = true;
		dx.post.mockImplementation(async (url: string, body: any) => {
			if (url === '/items/manufacturing_operations') return { data: { data: { operation_id: 'op-2' } } };
			if (url === '/files') {
				const name = (body as FormData).get('file') as File;
				if (cacheFails && name.name.endsWith('live_cache.bin')) throw serverErr();
				return { data: { data: { id: `file-${++fileN}` } } };
			}
			return { data: { data: {} } };
		});
		const w = await uploadable();
		await expect(w.uploadCutToDatabase()).rejects.toThrow(/file upload/);
		cacheFails = false;
		await expect(w.uploadCutToDatabase()).resolves.toBe('op-2');
		expect(posts('/items/manufacturing_operations')).toBe(1);
		expect(posts('/files')).toBe(3);   // mat once, cache failed once then uploaded
		const analysis = dx.post.mock.calls.find((c) => c[0] === '/items/machining_force_analysis')![1];
		expect(analysis.operation_id).toBe('op-2');
		expect(analysis.directus_files_id).toBe('file-1');
	});

	it('finds the row a lost response committed (by capture id) instead of inserting again', async () => {
		let first = true;
		dx.post.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') {
				if (first) { first = false; throw netErr(); }   // the server committed, the reply was lost
				return { data: { data: { operation_id: 'op-dup' } } };
			}
			if (url === '/files') return { data: { data: { id: `file-${++fileN}` } } };
			return { data: { data: {} } };
		});
		dx.get.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: [{ operation_id: 'op-lost', recorded_metadata: { capture_id: 'cap-up' } }] } };
			return { data: { data: [] } };   // no analysis row yet
		});
		const w = await uploadable();
		await expect(w.uploadCutToDatabase()).rejects.toThrow(/logging the run failed/);
		await expect(w.uploadCutToDatabase()).resolves.toBe('op-lost');
		expect(posts('/items/manufacturing_operations')).toBe(1);
		expect(dx.post.mock.calls.find((c) => c[0] === '/items/machining_force_analysis')![1].operation_id).toBe('op-lost');
	});

	it('does not post a second analysis row when the first attempt\'s reply was lost', async () => {
		let first = true;
		dx.post.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: { operation_id: 'op-3' } } };
			if (url === '/files') return { data: { data: { id: `file-${++fileN}` } } };
			if (url === '/items/machining_force_analysis' && first) { first = false; throw netErr(); }
			return { data: { data: {} } };
		});
		dx.get.mockImplementation(async (url: string) => (url === '/items/machining_force_analysis' ? { data: { data: [{ id: 'a-1', live_cache_file: 'file-c', directus_files_id: 'file-m' }] } } : { data: { data: [] } }));
		const w = await uploadable();
		await expect(w.uploadCutToDatabase()).rejects.toThrow(/linking/);
		await expect(w.uploadCutToDatabase()).resolves.toBe('op-3');
		expect(posts('/items/machining_force_analysis')).toBe(1);
	});
	// Review: a row that exists but lacks a file link used to be treated as "linked", so the files were
	// uploaded and then dropped, and the capture was shown as uploaded.
	describe('an analysis row that lacks a file link', () => {
		const row = (r: Record<string, unknown>) => dx.get.mockImplementation(async (url: string) => (
			url === '/items/machining_force_analysis' ? { data: { data: [{ id: 'a-1', ...r }] } } : { data: { data: [] } }));
		// the operation is the one an earlier attempt logged (progress is per capture id)
		const resumed = async () => { const w = await uploadable(); uploadProgress('cap-up').opId = 'op-old'; return w; };
		beforeEach(() => {
			dx.patch.mockReset(); dx.patch.mockResolvedValue({ data: { data: {} } });
			dx.post.mockImplementation(async (url: string) => {
				if (url === '/files') return { data: { data: { id: `file-${++fileN}` } } };
				if (url === '/items/manufacturing_operations') return { data: { data: { operation_id: 'op-new' } } };
				return { data: { data: {} } };
			});
		});

		it('PATCHes the missing .mat link onto the existing row, without a second row or a re-upload of the cache', async () => {
			row({ live_cache_file: 'cache-present', directus_files_id: null });
			const w = await resumed();
			await expect(w.uploadCutToDatabase()).resolves.toBe('op-old');
			expect(posts('/items/machining_force_analysis')).toBe(0);
			expect(posts('/files')).toBe(1);   // only the .mat
			expect(dx.patch).toHaveBeenCalledTimes(1);
			expect(dx.patch.mock.calls[0][0]).toBe('/items/machining_force_analysis/a-1');
			expect(dx.patch.mock.calls[0][1]).toEqual({ directus_files_id: 'file-1' });   // live_cache_file untouched
		});

		it('PATCHes the missing cache link and leaves a present .mat link alone', async () => {
			row({ live_cache_file: null, directus_files_id: 'mat-present' });
			const w = await resumed();
			await w.uploadCutToDatabase();
			expect(posts('/items/machining_force_analysis')).toBe(0);
			expect(dx.patch.mock.calls[0][1]).toEqual({ live_cache_file: 'file-1' });
			expect(posts('/files')).toBe(1);
		});

		it('a complete row uploads no files and writes nothing', async () => {
			row({ live_cache_file: 'c', directus_files_id: 'm' });
			const w = await resumed();
			await w.uploadCutToDatabase();
			expect(posts('/files')).toBe(0);
			expect(posts('/items/machining_force_analysis')).toBe(0);
			expect(dx.patch).not.toHaveBeenCalled();
		});

		it('a failed PATCH is a retryable linking error, and the retry PATCHes again', async () => {
			row({ live_cache_file: 'c', directus_files_id: null });
			dx.patch.mockRejectedValueOnce(serverErr());
			const w = await resumed();
			await expect(w.uploadCutToDatabase()).rejects.toThrow(/linking the capture failed/);
			await expect(w.uploadCutToDatabase()).resolves.toBe('op-old');
			expect(dx.patch).toHaveBeenCalledTimes(2);
			expect(posts('/files')).toBe(1);   // the .mat landed once and is remembered
		});
	});
});

describe('workspace.uploadCutToDatabase() with an unknown summary', () => {
	beforeEach(() => {
		fileN = 0; dx.get.mockResolvedValue({ data: { data: [] } });
		dx.post.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: { operation_id: 'op-s' } } };
			if (url === '/files') return { data: { data: { id: `file-${++fileN}` } } };
			return { data: { data: {} } };
		});
		replies['/captures/cap-up/live_cache.bin'] = { body: null };
	});
	const noSummary = async () => { const w = await uploadable(); w.st.summary = null; return w; };

	it('asks the recorder and skips the capture.mat of an over-size cut', async () => {
		replies['/captures/cap-up/summary'] = { body: { mat_written: false } };
		const w = await noSummary();
		await expect(w.uploadCutToDatabase()).resolves.toBe('op-s');
		expect(posts('/files')).toBe(1);
		expect(dx.post.mock.calls.find((c) => c[0] === '/items/machining_force_analysis')![1].directus_files_id).toBeNull();
	});

	it('fails retryably, without logging a run, when the summary cannot be read', async () => {
		replies['/captures/cap-up/summary'] = { ok: false, status: 503 };
		const w = await noSummary();
		await expect(w.uploadCutToDatabase()).rejects.toThrow(/capture summary/);
		expect(posts('/items/manufacturing_operations')).toBe(0);
	});
});

// ---- 2.5: Start is one-shot from the first click, not from the request ----
describe('workspace.start() (2.5)', () => {
	beforeEach(() => { alarmController.testedSinceStart.value = false; });

	it('a double click during the pre-flight prompt runs one start, and busy is held until it finishes', async () => {
		let answer!: (v: boolean) => void;
		confirmMock.confirmAction.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
		replies['/record/start'] = { body: { id: 'cap-s' } };
		const w = await make();
		const first = w.start();
		await Promise.resolve();
		expect(w.busy.value).toBe(true);        // set before the alarm prompt resolves
		await w.start();                         // the second click is ignored
		expect(calls.filter((c) => c === 'POST /record/start')).toHaveLength(0);
		answer(false);                           // "Start without testing"
		await first;
		expect(calls.filter((c) => c === 'POST /record/start')).toHaveLength(1);
		expect(w.busy.value).toBe(false);
		expect(w.st.state).toBe('recording');
	});

	it('clears busy when the operator declines the pre-flight', async () => {
		confirmMock.confirmAction.mockResolvedValueOnce(true);   // "Test alarms now": start is aborted
		const w = await make();
		await w.start();
		expect(w.busy.value).toBe(false);
		expect(calls.filter((c) => c === 'POST /record/start')).toHaveLength(0);
	});
});

// ---- R4: pre-flight checklist and "Start anyway" ----
describe('workspace pre-flight (R4)', () => {
	beforeEach(() => { alarmController.testedSinceStart.value = true; hwStatus.diskFreeGb = 200; });
	afterEach(() => { hwStatus.diskFreeGb = -1; });
	const startPosts = () => calls.filter((c) => c === 'POST /record/start').length;
	const item = (w: Awaited<ReturnType<typeof make>>, id: string) => w.preflight.value.find((it) => it.id === id);

	it('a missing Sample is a warning, and the first Start press asks instead of starting', async () => {
		replies['/record/start'] = { body: { id: 'cap-p1' } };
		const w = await make();
		w.link.sampleId = '';
		expect(item(w, 'sample')?.level).toBe('warn');
		await w.requestStart();
		expect(w.sampleConfirmOpen.value).toBe(true);
		expect(startPosts()).toBe(0);
		expect(w.st.state).toBe('idle');
	});

	it('"Start anyway" then starts, without a Sample', async () => {
		replies['/record/start'] = { body: { id: 'cap-p2' } };
		const w = await make();
		w.link.sampleId = '';
		await w.requestStart();
		await w.startAnyway();
		expect(w.sampleConfirmOpen.value).toBe(false);
		expect(startPosts()).toBe(1);
		expect(w.st.state).toBe('recording');
	});

	it('with a Sample set Start goes straight through, and picking one closes the prompt', async () => {
		replies['/record/start'] = { body: { id: 'cap-p3' } };
		const w = await make();
		w.link.sampleId = '';
		await w.requestStart();
		expect(w.sampleConfirmOpen.value).toBe(true);
		w.link.sampleId = 'sample-1';
		await nextTick();
		expect(w.sampleConfirmOpen.value).toBe(false);
		expect(item(w, 'sample')?.level).toBe('ok');
		await w.requestStart();
		expect(startPosts()).toBe(1);
	});

	it('reads the session, the disk poll and the form: offline note, runway from free space', async () => {
		const w = await make();
		auth.state.offline = true; auth.state.accessToken = null; auth.state.refreshToken = null;
		hwStatus.diskFreeGb = 61;
		w.cfg.sample_rate = 25000;
		expect(item(w, 'auth')?.level).toBe('info');
		expect(item(w, 'disk')?.detail).toMatch(/61\.0 GB free, about 17 h at 25,000 Hz/);
		auth.state.offline = false; auth.state.refreshToken = 'rt';
	});

	it('NI-DAQ adds the amp, tacho and channel items once read; replay has none', async () => {
		labampMock.status.mockResolvedValueOnce({ reachable: true, mode: 'RESET', mock: false });
		replies['/nidaq/channels'] = { body: { channels: [], roles: [], colors: {} } };
		const w = await make();
		w.setSource('nidaq');
		await w.refreshPreflight();
		expect(w.preflight.value.map((it) => it.id)).toEqual(['sample', 'auth', 'amp', 'tacho', 'disk', 'channels']);
		expect(item(w, 'amp')?.level).toBe('ok');
		expect(item(w, 'channels')?.level).toBe('warn');   // an empty list: nothing assigned
		w.setSource('replay');
		expect(w.preflight.value).toEqual([]);
	});

	it('the channel check follows the list Start sends: a custom Record-page list skips the saved-model check', async () => {
		labampMock.status.mockResolvedValueOnce({ reachable: true, mode: 'RESET', mock: false });
		replies['/nidaq/channels'] = { body: { channels: [], roles: [], colors: {} } };   // the model would warn
		const w = await make();
		w.setSource('nidaq');
		await w.refreshPreflight();
		expect(item(w, 'channels')?.level).toBe('warn');        // default list: the saved model records
		w.nidaqChannels.value = 'Dev1/ai0\nDev1/ai1';
		expect(item(w, 'channels')?.level).toBe('skip');        // custom list: the model is not what records
		expect(item(w, 'channels')?.detail).toMatch(/custom channel list/i);
		w.nidaqChannels.value = '';
		expect(item(w, 'channels')?.level).toBe('warn');        // empty: the backend uses the model again
	});

	it('the model\'s own physical list (first-boot autoassign) is not custom: the chip still checks the model', async () => {
		labampMock.status.mockResolvedValue({ reachable: true, mode: 'RESET', mock: false });
		const model = ['Fx1', 'Fx2', 'Fy1', 'Fy2', 'Fz1', 'Fz2', 'Fz3', 'Fz4', 'Tacho'].map((name, i) => ({
			name, role: name, source: 'hardware', physical: i < 8 ? `Dev1/ai${i}` : 'Dev2/ai0',
		}));
		model[3].physical = 'Dev1/ai0';   // a duplicate input: the model check fails
		replies['/nidaq/channels'] = { body: { channels: model, roles: [], colors: {} } };
		const w = await make();
		w.setSource('nidaq');
		await w.refreshPreflight();
		w.nidaqChannels.value = model.map((c) => c.physical).join('\n');   // what autoassign writes
		expect(item(w, 'channels')?.level).toBe('fail');         // checked against the model
		w.nidaqChannels.value = model.slice(1).map((c) => c.physical).join('\n');
		expect(item(w, 'channels')?.level).toBe('skip');         // hand-edited (different list)
		w.nidaqChannels.value = model.map((c) => ` ${c.physical} `).join(',');   // same list, other whitespace/separators
		expect(item(w, 'channels')?.level).toBe('fail');
	});

	it('an unreadable amp or channel list is "not checked", not a failure', async () => {
		const w = await make();
		w.setSource('nidaq');
		labampMock.status.mockRejectedValueOnce(new TypeError('Failed to fetch'));
		await w.refreshPreflight();                           // the amp read rejects, the channel read 404s
		expect(item(w, 'amp')?.level).toBe('skip');
		expect(item(w, 'channels')?.level).toBe('skip');
	});
});

// ---- 2.7: late replies from superseded searches / picks are dropped ----
function deferred<T>() {
	let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
const row = (id: string) => ({ id, live_cache_file: `cache-${id}`, operation_id: { operation_id: null, pass_code: `P-${id}` } });

describe('workspace.searchCuts() (2.7)', () => {
	it('a slow older search cannot overwrite the newer one\'s options', async () => {
		const slow = deferred<any>(); const fast = deferred<any>();
		dx.get.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
		const w = await make();
		const a = w.searchCuts('old');
		const b = w.searchCuts('new');
		fast.resolve({ data: { data: [row('new')] } });
		await b;
		expect(w.replay.options.map((o) => o.opId)).toEqual(['new']);
		expect(w.replay.loading).toBe(false);
		slow.resolve({ data: { data: [row('old')] } });
		await a;
		expect(w.replay.options.map((o) => o.opId)).toEqual(['new']);
	});

	it('a failure of a superseded search does not clear the newer results or the spinner state', async () => {
		const slow = deferred<any>(); const fast = deferred<any>();
		dx.get.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
		const w = await make();
		const a = w.searchCuts('old');
		const b = w.searchCuts('new');
		slow.reject(new Error('timeout'));
		await a;
		expect(w.replay.loading).toBe(true);   // the newer search is still out
		fast.resolve({ data: { data: [row('new')] } });
		await b;
		expect(w.replay.options.map((o) => o.opId)).toEqual(['new']);
	});
});

describe('workspace.pickReplayCut() (2.7)', () => {
	const opt = (id: string) => ({
		label: id, cacheId: `cache-${id}`, opId: id, operationId: null, ppr: null, outerDiam: null,
		innerDiam: null, sampleRate: null, cropStartSec: null,
	});

	it('a download that finishes after switching to Sim does not load into the playhead', async () => {
		const dl = deferred<any>();
		dx.get.mockReturnValueOnce(dl.promise);
		const w = await make();
		const load = vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		w.setSource('replay');
		const p = w.pickReplayCut(opt('a'));
		expect(w.replay.downloading).toBe(true);
		w.setSource('sim');
		expect(w.replay.downloading).toBe(false);
		dl.resolve({ data: new ArrayBuffer(8) });
		await p;
		expect(load).not.toHaveBeenCalled();
		expect(w.replay.cacheId).toBe('');
	});

	it('of two picks, only the later one loads, whichever download finishes first', async () => {
		const first = deferred<any>(); const second = deferred<any>();
		dx.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const w = await make();
		const load = vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		w.setSource('replay');
		const a = w.pickReplayCut(opt('a'));
		const b = w.pickReplayCut(opt('b'));
		second.resolve({ data: new ArrayBuffer(8) });
		await b;
		first.resolve({ data: new ArrayBuffer(8) });
		await a;
		expect(load).toHaveBeenCalledTimes(1);
		expect(w.replay.cacheId).toBe('cache-b');
		expect(w.replay.downloading).toBe(false);
	});

	it('a superseded pick\'s error does not overwrite the current state', async () => {
		const first = deferred<any>();
		dx.get.mockReturnValueOnce(first.promise);
		const w = await make();
		vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		w.setSource('replay');
		const a = w.pickReplayCut(opt('a'));
		w.setSource('sim');
		first.reject(new Error('network'));
		await a;
		expect(w.errMsg.value).toBeNull();
	});
});

// ---- the amp goes back to RESET once a long finalize ends, not while the recorder is busy ----
describe('workspace.stop() returns the amp to RESET after finalize', () => {
	beforeEach(() => { labampMock.setMode.mockClear(); localStorage.setItem('force-app.source', 'nidaq'); });
	const resets = () => labampMock.setMode.mock.calls.filter((c) => c[0] === 'RESET').length;

	async function stopping(state: string) {
		replies['/record/stop'] = { body: { state, id: 'cap-a' } };
		replies['/captures/cap-a/summary'] = { body: {} };
		const w = await make();
		w.setSource('nidaq');
		labampMock.setMode.mockClear();
		w.st.state = 'recording'; w.st.captureId = 'cap-a';
		await w.stop();
		return w;
	}

	it('while finalizing sends nothing yet, then one RESET when it reaches done', async () => {
		const w = await stopping('finalizing');
		expect(resets()).toBe(0);
		w.st.state = 'done';
		expect(resets()).toBe(1);
		w.st.state = 'idle'; w.st.state = 'done';
		expect(resets()).toBe(1);
	});

	it('also resets when the finalize ends in error', async () => {
		const w = await stopping('finalizing');
		w.st.state = 'error';
		expect(resets()).toBe(1);
	});

	it('does not reset if a new recording started meanwhile', async () => {
		const w = await stopping('finalizing');
		w.st.state = 'recording'; w.st.captureId = 'cap-b';
		w.st.state = 'done';
		expect(resets()).toBe(0);
	});

	it('an already-settled stop resets straight away', async () => {
		await stopping('done');
		expect(resets()).toBe(1);
	});
});

describe('remembered setup (R1)', () => {
	const KEY = 'force-app.record.setup.v1';
	const hide: Array<() => void> = [];
	beforeEach(() => {
		hide.length = 0;
		vi.stubGlobal('window', {
			addEventListener: (ev: string, fn: () => void) => { if (ev === 'pagehide') hide.push(fn); },
			removeEventListener: () => {},
		});
	});
	const pageHide = () => hide.forEach((f) => f());
	const stored = () => JSON.parse(localStorage.getItem(KEY) || 'null');
	const seed = (o: unknown) => localStorage.setItem(KEY, JSON.stringify(o));

	it('starts from the defaults (and no fake sample name) with nothing stored', async () => {
		const w = await make();
		expect(w.cfg.rpm).toBe(1200);
		expect(w.meta.sample_name).toBe('');
		expect(w.link.sampleId).toBe('');
	});

	it('restores a stored setup, never the per-cut fields', async () => {
		seed({
			cfg: { rpm: 900, feed: 0.2, diam: 40, inner_diam: 5, sample_rate: 10000, ppr: 2 },
			link: { sampleId: 's1', sampleLabel: 'S-1', operatorId: 'p1', operatorLabel: 'Pat', equipmentId: 'e1', equipmentLabel: 'Lathe' },
			meta: { sample_name: 'S-1', op_type: 'MT-F', coolant: 'flood', notes: 'stale', operation: 'stale' },
			machining: { axial_doc: '1.5', operation_sequence: '7', chips_ref: 'X', new_edge: true, chips_collected: true },
		});
		const w = await make();
		expect(w.cfg).toMatchObject({ rpm: 900, feed: 0.2, diam: 40, inner_diam: 5, sample_rate: 10000, ppr: 2 });
		expect(w.link).toMatchObject({ sampleId: 's1', operatorLabel: 'Pat', equipmentId: 'e1' });
		expect(w.meta).toMatchObject({ sample_name: 'S-1', op_type: 'MT-F', coolant: 'flood', notes: '', operation: '' });
		expect(w.machining).toMatchObject({ axial_doc: '1.5', operation_sequence: '', chips_ref: '', new_edge: false, chips_collected: false });
	});

	it('writes on page hide, without per-cut fields', async () => {
		const w = await make();
		w.cfg.rpm = 1500; w.link.sampleId = 's9'; w.link.sampleLabel = 'S-9';
		w.meta.notes = 'only this cut'; w.machining.chips_ref = 'CH-1'; w.machining.operation_sequence = '3';
		await nextTick();
		pageHide();
		const o = stored();
		expect(o.cfg.rpm).toBe(1500);
		expect(o.link.sampleId).toBe('s9');
		expect(JSON.stringify(o)).not.toMatch(/only this cut|CH-1|operation_sequence|chips|notes/);
	});

	it('a restored link does not fight Replay: entering Replay clears it and the clearing is not stored', async () => {
		seed({ link: { sampleId: 's1', sampleLabel: 'S-1', equipmentId: 'e1', equipmentLabel: 'Lathe', operatorId: 'p1', operatorLabel: 'Pat' }, meta: { op_type: 'MT-F' } });
		const w = await make();
		expect(w.link.sampleId).toBe('s1');
		w.setSource('replay');
		expect(w.link.sampleId).toBe(''); expect(w.link.equipmentId).toBe(''); expect(w.meta.op_type).toBe('');
		await nextTick();
		pageHide();
		expect(stored().link.sampleId).toBe('s1');   // the remembered setup is still there for the next Record launch
		expect(stored().meta.op_type).toBe('MT-F');
	});

	const SETUP = {
		cfg: { rpm: 900 },
		link: { sampleId: 's1', sampleLabel: 'S-1', equipmentId: 'e1', equipmentLabel: 'Lathe', operatorId: 'p1', operatorLabel: 'Pat' },
		meta: { sample_name: 'S-1', sample_code: 'S-1', op_type: 'MT-F', coolant: 'flood' },
	};

	it('Replay then straight back to Simulated keeps the remembered setup, in storage and in the form', async () => {
		seed(SETUP);
		const w = await make();
		w.setSource('replay');
		w.setSource('sim');
		await nextTick();
		pageHide();
		expect(stored().link.sampleId).toBe('s1');
		expect(stored().link.equipmentId).toBe('e1');
		expect(stored().meta.op_type).toBe('MT-F');
		expect(w.link).toMatchObject({ sampleId: 's1', equipmentId: 'e1', operatorId: 'p1' });
		expect(w.meta).toMatchObject({ sample_name: 'S-1', op_type: 'MT-F', coolant: 'flood' });
	});

	it('a cut picked in Replay does not become the setup when switching to NI-DAQ', async () => {
		seed(SETUP);
		dx.get.mockResolvedValueOnce({ data: new ArrayBuffer(8) }).mockResolvedValueOnce({ data: { data: {
			sample_id: { sample_id: 'arch-s', sample_code: 'ARCH' },
			operator_person_id: { person_id: 'arch-p', full_name: 'Archie' },
			equipment_id: { equipment_id: 'arch-e', equipment_name: 'Mill 9' },
			machining_operation_subtype: 'MM-S', machining_axial_depth_of_cut_mm: 3,
			recorded_metadata: { sample_name: 'ARCH', coolant: 'dry' },
		} } });
		const w = await make();
		vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		w.setSource('replay');
		await w.pickReplayCut({ label: 'c', cacheId: 'cache-c', opId: 'c', operationId: 'op-c', ppr: null, outerDiam: null, innerDiam: null, sampleRate: null, cropStartSec: null });
		expect(w.link.sampleId).toBe('arch-s');   // hydrated for playback
		w.setSource('nidaq');
		await nextTick();
		pageHide();
		expect(stored().link).toMatchObject({ sampleId: 's1', operatorId: 'p1', equipmentId: 'e1' });
		expect(stored().meta).toMatchObject({ op_type: 'MT-F', coolant: 'flood', sample_name: 'S-1' });
		expect(stored().machining.axial_doc).toBe('');
		expect(w.link).toMatchObject({ sampleId: 's1', operatorId: 'p1', equipmentId: 'e1' });
		expect(w.meta).toMatchObject({ sample_name: 'S-1', op_type: 'MT-F', coolant: 'flood' });
		expect(w.machining.axial_doc).toBe('');
	});

	it("a cut picked in Replay leaves none of its per-cut fields or tooling in the form after leaving Replay", async () => {
		seed(SETUP);
		dx.get.mockResolvedValueOnce({ data: new ArrayBuffer(8) }).mockResolvedValueOnce({ data: { data: {
			sample_id: { sample_id: 'arch-s', sample_code: 'ARCH' },
			tool_id: { tool_id: 'arch-t', tool_name: 'Old holder' },
			insert_edge_id: { edge_id: 'arch-edge', edge_code: 'E9', insert_id: { insert_id: 'arch-i', insert_code: 'I9' } },
			operation_sequence: 7, machining_chips_ref_code: 'CH-7', machining_new_edge: true, machining_chips_collected: true,
			outcome_notes: 'archived note',
		} } });
		const w = await make();
		vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		w.link.edgeId = 'my-edge'; w.link.edgeLabel = 'E1'; w.meta.notes = 'my note'; w.machining.operation_sequence = '3';
		w.setSource('replay');
		await w.pickReplayCut({ label: 'c', cacheId: 'cache-c', opId: 'c', operationId: 'op-c', ppr: null, outerDiam: null, innerDiam: null, sampleRate: null, cropStartSec: null });
		expect(w.link.edgeId).toBe('arch-edge');   // hydrated for playback
		w.setSource('nidaq');
		expect(w.link).toMatchObject({ edgeId: 'my-edge', edgeLabel: 'E1', insertId: '', toolId: '' });
		expect(w.meta.notes).toBe('my note');
		expect(w.machining).toMatchObject({ operation_sequence: '3', chips_ref: '', new_edge: false, chips_collected: false });
	});

	it("a launch straight into Replay leaves the hydrated cut's per-cut fields blank on leaving", async () => {
		localStorage.setItem('force-app.source', 'replay');
		seed(SETUP);
		dx.get.mockResolvedValueOnce({ data: new ArrayBuffer(8) }).mockResolvedValueOnce({ data: { data: {
			insert_edge_id: { edge_id: 'arch-edge', edge_code: 'E9', insert_id: { insert_id: 'arch-i', insert_code: 'I9' } },
			operation_sequence: 7, outcome_notes: 'archived note',
		} } });
		const w = await make();
		vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		await w.pickReplayCut({ label: 'c', cacheId: 'cache-c', opId: 'c', operationId: 'op-c', ppr: null, outerDiam: null, innerDiam: null, sampleRate: null, cropStartSec: null });
		w.setSource('sim');
		expect(w.link).toMatchObject({ edgeId: '', insertId: '' });
		expect(w.meta.notes).toBe('');
		expect(w.machining.operation_sequence).toBe('');
	});

	it('re-entering Replay with a cut still loaded shows that cut again, not the recording setup', async () => {
		seed(SETUP);
		dx.get.mockResolvedValueOnce({ data: new ArrayBuffer(8) }).mockResolvedValueOnce({ data: { data: {
			sample_id: { sample_id: 'arch-s', sample_code: 'ARCH' },
			equipment_id: { equipment_id: 'arch-e', equipment_name: 'Mill 9' },
			machining_operation_subtype: 'MM-S',
			insert_edge_id: { edge_id: 'arch-edge', edge_code: 'E9', insert_id: { insert_id: 'arch-i', insert_code: 'I9' } },
		} } });
		const w = await make();
		vi.spyOn(w.playback, 'load').mockImplementation(() => {});
		w.setSource('replay');
		await w.pickReplayCut({ label: 'c', cacheId: 'cache-c', opId: 'c', operationId: 'op-c', ppr: null, outerDiam: null, innerDiam: null, sampleRate: null, cropStartSec: null });
		w.setSource('sim');
		expect(w.link).toMatchObject({ sampleId: 's1', equipmentId: 'e1', edgeId: '' });
		w.setSource('replay');
		expect(w.link).toMatchObject({ sampleId: 'arch-s', equipmentId: 'arch-e', edgeId: 'arch-edge' });
		expect(w.meta.op_type).toBe('MM-S');
		w.setSource('sim');
		expect(w.link).toMatchObject({ sampleId: 's1', equipmentId: 'e1', edgeId: '' });
	});

	it('leaving Replay brings back the setup from memory even when storage refused the write', async () => {
		seed(SETUP);
		const w = await make();
		w.cfg.rpm = 1500;
		const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
		w.setSource('replay');
		w.setSource('sim');
		spy.mockRestore();
		expect(w.cfg.rpm).toBe(1500);
		expect(w.link.sampleId).toBe('s1');
	});

	it('an edit made just before entering Replay is stored, and not lost to the clearing', async () => {
		seed(SETUP);
		const w = await make();
		w.cfg.rpm = 1500;
		w.setSource('replay');   // synchronously after the edit: the watcher has not run yet
		await nextTick();
		pageHide();
		expect(stored().cfg.rpm).toBe(1500);
		expect(stored().link.sampleId).toBe('s1');
	});

	it('a launch that opens straight into Replay does not bring Sample/Machine/type back', async () => {
		localStorage.setItem('force-app.source', 'replay');
		seed({ link: { sampleId: 's1', sampleLabel: 'S-1', equipmentId: 'e1', equipmentLabel: 'Lathe', operatorId: 'p1', operatorLabel: 'Pat' }, meta: { op_type: 'MT-F', sample_name: 'S-1' } });
		const w = await make();
		expect(w.source.value).toBe('replay');
		expect(w.link.sampleId).toBe(''); expect(w.link.equipmentId).toBe('');
		expect(w.meta.op_type).toBe(''); expect(w.meta.sample_name).toBe('');
		expect(w.link.operatorId).toBe('p1'); // Operator never narrowed the cut search
	});

	it('Clear setup resets the form and forgets the stored copy', async () => {
		seed({ cfg: { rpm: 900 }, link: { sampleId: 's1' } });
		const w = await make();
		w.meta.notes = 'n'; w.meta.tool = 'T'; w.meta.insert = 'I'; w.meta.edge_id = 'E'; w.machining.chips_ref = 'c'; w.link.toolId = 't';
		w.clearSetup();
		expect(w.cfg.rpm).toBe(1200);
		expect(w.link.sampleId).toBe('');
		expect(w.link.toolId).toBe('');
		expect(w.meta.notes).toBe(''); expect(w.machining.chips_ref).toBe('');
		expect(w.meta.tool || '').toBe(''); expect(w.meta.insert).toBe(''); expect(w.meta.edge_id).toBe('');
		expect(localStorage.getItem(KEY)).toBeNull();
		await nextTick();
		pageHide();
		expect(localStorage.getItem(KEY)).toBeNull(); // an all-default setup is never written back
	});
});

describe('stop on force alarm while busy', () => {
	afterEach(() => {
		alarmController.reset();
		alarmController.config.audioEnabled = true; alarmController.config.stopOnForceAlarm = false;
	});

	it('a trip that lands while busy stops the recording once busy clears', async () => {
		replies['/record/stop'] = { body: {} };
		replies['/record/status'] = { body: { state: 'done', id: 'cap-t' } };
		replies['/captures/cap-t/summary'] = { body: { duration_sec: 3 } };
		replies['/captures/cap-t/live_cache.bin'] = { body: null };
		const w = await make();
		w.st.state = 'recording'; w.st.captureId = 'cap-t';
		w.busy.value = true;                 // e.g. start() is still finishing
		alarmController.reset();
		alarmController.config.audioEnabled = false;
		alarmController.config.stopOnForceAlarm = true;
		alarmController.evaluate({ Fx: 410, Fy: 0, Fz: 0 }, 0, 1200);
		await nextTick();
		expect(calls).not.toContain('POST /record/stop');
		w.busy.value = false;
		await nextTick(); await Promise.resolve();
		expect(calls).toContain('POST /record/stop');
		expect(w.saveOpen.value).toBe(true);
	});

	it('does not stop again later when the cut ended while busy', async () => {
		const w = await make();
		w.st.state = 'recording';
		w.busy.value = true;
		alarmController.reset();
		alarmController.config.audioEnabled = false;
		alarmController.config.stopOnForceAlarm = true;
		alarmController.evaluate({ Fx: 410, Fy: 0, Fz: 0 }, 0, 1200);
		w.st.state = 'done';
		w.busy.value = false;
		await nextTick(); await Promise.resolve();
		expect(calls).not.toContain('POST /record/stop');
	});
});

describe('workspace.newRun() (R3)', () => {
	it('clears the early-warning banner but not an unacknowledged alarm', async () => {
		const w = await make();
		alarmController.reset();
		const audio = alarmController.config.audioEnabled;
		alarmController.config.audioEnabled = false; // no Web Audio in the test environment
		alarmController.evaluate({ Fx: 330, Fy: 0, Fz: 0 }, 0, 1200); // warning at 320 N (default 400 N limit)
		alarmController.evaluate({ Fx: 0, Fy: 410, Fz: 0 }, 0, 1200);
		expect(alarmController.warnings).toHaveLength(1);
		w.newRun();
		expect(alarmController.warnings).toHaveLength(0);
		expect(alarmController.tripped).toBe(true);
		alarmController.reset();
		alarmController.config.audioEnabled = audio;
	});

	it('steps a numeric operation sequence and clears chips ref, chips collected and new edge', async () => {
		const w = await make();
		w.machining.operation_sequence = '4'; w.machining.chips_ref = 'CH-4';
		w.machining.chips_collected = true; w.machining.new_edge = true;
		w.meta.operation = 'typed-pass'; w.meta.notes = 'kept';
		w.newRun();
		expect(w.machining.operation_sequence).toBe('5');
		expect(w.machining.chips_ref).toBe('');
		expect(w.machining.chips_collected).toBe(false);
		expect(w.machining.new_edge).toBe(false);
		expect(w.meta.operation).toBe('typed-pass');   // free text: not derived from the sequence
		expect(w.meta.notes).toBe('kept');
	});

	it('clears a pass code that is the auto-composed Cut ID, but not free text', async () => {
		const w = await make();
		w.link.sampleLabel = 'S-1'; w.meta.op_type = 'MT-F'; w.machining.operation_sequence = '4';
		w.meta.operation = 'S-1-MT4';   // what the Cut ID "use" button copies in
		w.newRun();
		expect(w.meta.operation).toBe('');
		expect(w.machining.operation_sequence).toBe('5');
		w.meta.operation = 'hand-typed';
		w.newRun();
		expect(w.meta.operation).toBe('hand-typed');
	});

	it('keeps the composed pass code when the cut is discarded (same cut)', async () => {
		const w = await make();
		w.link.sampleLabel = 'S-1'; w.meta.op_type = 'MT-F'; w.machining.operation_sequence = '4';
		w.meta.operation = 'S-1-MT4';
		w.newRun(false);
		expect(w.meta.operation).toBe('S-1-MT4');
	});

	it('leaves a blank or non-numeric sequence alone', async () => {
		const w = await make();
		w.newRun();
		expect(w.machining.operation_sequence).toBe('');
		w.machining.operation_sequence = '2b';
		w.newRun();
		expect(w.machining.operation_sequence).toBe('2b');
	});

	it('closing a failed start keeps the sequence, chips and new-edge mark (nothing was captured)', async () => {
		const w = await make();
		w.machining.operation_sequence = '4'; w.machining.chips_ref = 'CH-4'; w.machining.new_edge = true;
		w.saveOpen.value = true;
		w.dismissFailure(false);
		expect(w.saveOpen.value).toBe(false);
		expect(w.machining.operation_sequence).toBe('4');
		expect(w.machining.chips_ref).toBe('CH-4');
		expect(w.machining.new_edge).toBe(true);
	});

	it('closing a failed capture that kept the raw steps the sequence (it was a real pass)', async () => {
		const w = await make();
		w.machining.operation_sequence = '4'; w.machining.chips_ref = 'CH-4'; w.machining.new_edge = true;
		w.saveOpen.value = true;
		w.dismissFailure(true);
		expect(w.saveOpen.value).toBe(false);
		expect(w.machining.operation_sequence).toBe('5');
		expect(w.machining.chips_ref).toBe('');
		expect(w.machining.new_edge).toBe(false);
	});

	it('a discarded cut keeps the sequence and the per-cut marks (the retake is the same cut)', async () => {
		const w = await make();
		w.machining.operation_sequence = '4'; w.machining.chips_ref = 'CH-4'; w.machining.new_edge = true;
		w.newRun(false);
		expect(w.machining.operation_sequence).toBe('4');
		expect(w.machining.chips_ref).toBe('CH-4');
		expect(w.machining.new_edge).toBe(true);
	});
});

// ---- R5: live rail warning ----
describe('workspace.railBanner (R5)', () => {
	const railed = (w: Awaited<ReturnType<typeof make>>, ch: number[]) => { w.st.railed = ch; return nextTick(); };

	it('shows nothing until a channel rails, then names it', async () => {
		const w = await make();
		expect(w.railBanner.value).toBeNull();
		await railed(w, [2]);
		expect(w.railBanner.value).toBe('Ch Fy1 railed - re-range before the next cut');
	});

	it('appears once per cut: Dismiss keeps it away for the rest of the cut, even as more channels rail', async () => {
		const w = await make();
		await railed(w, [2]);
		w.dismissRailBanner();
		expect(w.railBanner.value).toBeNull();
		await railed(w, [2, 5]);          // the backend re-sends the set every couple of seconds
		await railed(w, [2, 5]);
		expect(w.railBanner.value).toBeNull();
	});

	it('comes back for the next cut after New', async () => {
		const w = await make();
		await railed(w, [2]);
		w.dismissRailBanner();
		w.newRun();                        // client.reset() clears the railed set
		await nextTick();
		expect(w.st.railed).toEqual([]);
		expect(w.railBanner.value).toBeNull();
		await railed(w, [4]);
		expect(w.railBanner.value).toBe('Ch Fz1 railed - re-range before the next cut');
	});

	it('a dismissal belongs to its capture: adopting another railed cut shows its banner', async () => {
		const w = await make();
		w.st.captureId = 'cap-a';
		await railed(w, [2]);
		w.dismissRailBanner();
		expect(w.railBanner.value).toBeNull();
		// A reconcile adopts a different railed cut: `railed` never passed through empty.
		w.st.captureId = 'cap-b';
		await railed(w, [3]);
		expect(w.railBanner.value).toBe('Ch Fy2 railed - re-range before the next cut');
		w.st.captureId = 'cap-a';           // and cap-a stays dismissed if it is shown again
		await railed(w, [2]);
		expect(w.railBanner.value).toBeNull();
	});

	it('is not shown for a replayed cut', async () => {
		const w = await make();
		w.setSource('replay');
		await railed(w, [2]);
		expect(w.railBanner.value).toBeNull();
	});
});
