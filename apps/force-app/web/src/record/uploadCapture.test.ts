import { beforeEach, describe, expect, it, vi } from 'vitest';

// api.post is the seam for the manufacturing_operations insert AND the two file uploads (/files);
// api.get isn't used by this path. The .mat/live_cache fetches go through global fetch.
const post = vi.fn();
const get = vi.fn();
const patchFn = vi.hoisted(() => vi.fn());
vi.mock('../directusClient', () => ({ api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a), patch: (...a: unknown[]) => patchFn(...a) } }));
// Uploading needs a real (non-offline) session; `user` is whoever is signed in at upload time.
const auth = vi.hoisted(() => ({
	state: { user: { id: 'u-uploader', email: 'up@lab.org' } as any, offline: false, accessToken: 'at' as string | null, refreshToken: 'rt' as string | null },
}));
vi.mock('../authStore', () => ({ authStore: auth }));
vi.mock('./directusLookups', () => ({ resolveMachiningMethodId: vi.fn().mockResolvedValue('method-1') }));
vi.mock('@d1/force-plotting', () => ({
	parseCache: vi.fn(() => ({})),
	buildSeriesEnvelope: vi.fn(() => null),
}));

import { uploadCaptureColdStart, uploadFile, uploadsInFlight } from './uploadCapture';
import { clearUploadProgress } from './uploadResume';

function mockFetchOk() {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) }));
}

beforeEach(() => {
	clearUploadProgress();
	auth.state.offline = false; auth.state.accessToken = 'at'; auth.state.refreshToken = 'rt';
	auth.state.user = { id: 'u-uploader', email: 'up@lab.org' };
	post.mockReset();
	get.mockReset();
	get.mockResolvedValue({ data: { data: [] } });
	mockFetchOk();
	// operation insert -> file uploads (x2) -> analysis record insert
	post.mockImplementation((url: string) => {
		if (url === '/items/manufacturing_operations') {
			return Promise.resolve({ data: { data: { operation_id: 'op-123' } } });
		}
		if (url === '/files') return Promise.resolve({ data: { data: { id: 'file-1' } } });
		return Promise.resolve({ data: { data: {} } });
	});
});

const BASE_INFO = {
	captureId: 'cap-1',
	matUrl: 'http://x/cap-1.mat',
	cacheUrl: 'http://x/cap-1_live_cache.bin',
	peaks: { Fx: 1, Fy: 2, Fz: 3 },
};

describe('uploadsInFlight (the rig-test upload_busy source)', () => {
	it('counts a file while it uploads and drops back when it lands', async () => {
		let release!: (v: unknown) => void;
		post.mockImplementationOnce(() => new Promise((r) => { release = r; }));
		const up = uploadFile(new Blob(['x']), 'a.bin');
		expect(uploadsInFlight.value).toBe(1);
		release({ data: { data: { id: 'f1' } } });
		await expect(up).resolves.toBe('f1');
		expect(uploadsInFlight.value).toBe(0);
	});
	it('drops back when an upload fails, too', async () => {
		post.mockRejectedValueOnce(new Error('boom'));
		await expect(uploadFile(new Blob(['x']), 'a.bin')).rejects.toThrow(/file upload \(a\.bin\) failed/);
		expect(uploadsInFlight.value).toBe(0);
	});
	it('sees both files of a cold-start upload, and is idle after it', async () => {
		const seen: number[] = [];
		post.mockImplementation((url: string) => {
			if (url === '/files') { seen.push(uploadsInFlight.value); return Promise.resolve({ data: { data: { id: 'file-1' } } }); }
			if (url === '/items/manufacturing_operations') return Promise.resolve({ data: { data: { operation_id: 'op-1' } } });
			return Promise.resolve({ data: { data: {} } });
		});
		await uploadCaptureColdStart({ ...BASE_INFO, cfg: {}, matWritten: true });
		expect(seen.length).toBe(2);
		expect(seen.every((n) => n >= 1)).toBe(true);
		expect(uploadsInFlight.value).toBe(0);
	});
});

describe('uploadCaptureColdStart', () => {
	it('links the resolved sample/operator/etc. when the capture persisted them', async () => {
		// Regression: this used to send NO relational columns at all, so a cold-started upload could
		// never link a sample even when one had genuinely been picked at record time — only the
		// free-text label survived to summary.json, not the resolved Directus UUID.
		await uploadCaptureColdStart({
			...BASE_INFO,
			cfg: {
				rpm: 1200, feed: 0.05, diam: 80, sample_rate: 25000, source: 'nidaq',
				extra_metadata: {
					link_sample_id: 'sample-uuid-1', link_sample_label: 'S-42',
					link_operator_id: 'op-uuid-1', link_equipment_id: 'eq-uuid-1',
					link_edge_id: 'edge-uuid-1', link_tool_id: 'tool-uuid-1',
				},
			},
		});

		const opCall = post.mock.calls.find(([url]) => url === '/items/manufacturing_operations');
		expect(opCall).toBeTruthy();
		const payload = opCall![1];
		expect(payload.sample_id).toBe('sample-uuid-1');
		expect(payload.operator_person_id).toBe('op-uuid-1');
		expect(payload.equipment_id).toBe('eq-uuid-1');
		expect(payload.insert_edge_id).toBe('edge-uuid-1');
		expect(payload.tool_id).toBe('tool-uuid-1');
	});

	it('sends null (not an absent key) for lookups that were never picked', async () => {
		// The database's manufacturing_operations_has_sample CHECK requires sample_id OR
		// output_sample_id OR source_system — an absent key and an explicit null behave the same to
		// Postgres, but being explicit here is what makes the intent ("genuinely no sample") legible
		// rather than looking like an accidental omission.
		await uploadCaptureColdStart({
			...BASE_INFO,
			cfg: { rpm: 1200, source: 'nidaq', extra_metadata: {} },
		});
		const payload = post.mock.calls.find(([url]) => url === '/items/manufacturing_operations')![1];
		expect(payload.sample_id).toBeNull();
		expect(payload.operator_person_id).toBeNull();
	});

	it('sends machining detail fields as numbers, not the raw strings they are stored as', async () => {
		await uploadCaptureColdStart({
			...BASE_INFO,
			cfg: {
				rpm: 1200, source: 'nidaq',
				extra_metadata: { axial_doc: '1.5', radial_doc: '', cutting_length: '12', new_edge: true, chips_collected: false },
			},
		});
		const payload = post.mock.calls.find(([url]) => url === '/items/manufacturing_operations')![1];
		expect(payload.machining_axial_depth_of_cut_mm).toBe(1.5);
		expect(payload.machining_radial_depth_of_cut_mm).toBeNull(); // blank string -> null, not NaN/0
		expect(payload.machining_cutting_length_mm).toBe(12);
		expect(payload.machining_new_edge).toBe(true);
		expect(payload.machining_chips_collected).toBe(false);
	});

	it('returns the created operation_id', async () => {
		const opId = await uploadCaptureColdStart({ ...BASE_INFO, cfg: { source: 'nidaq', extra_metadata: {} } });
		expect(opId).toBe('op-123');
	});

	describe('a capture recorded earlier, possibly offline, by someone else', () => {
		const recordedBy = {
			recorded_by_user_id: 'u-recorder', recorded_by_email: 'rec@lab.org', recorded_by_name: 'Rita Recorder',
			recorded_by_person_id: 'person-rita', recorded_offline: true, recorded_at: '2026-09-28T09:15:00.000Z',
		};

		it('keeps the recorder as owner and the recording time, not the uploader and upload time', async () => {
			await uploadCaptureColdStart({ ...BASE_INFO, cfg: { source: 'nidaq', extra_metadata: { ...recordedBy } } });
			const payload = post.mock.calls.find(([url]) => url === '/items/manufacturing_operations')![1];
			expect(payload.owner_person_id).toBe('person-rita');
			expect(payload.operation_date).toBe('2026-09-28T09:15:00.000Z');
			expect(payload.recorded_metadata).toMatchObject({
				recorded_by_user_id: 'u-recorder', recorded_by_name: 'Rita Recorder', recorded_offline: true,
				synced_by_user_id: 'u-uploader', synced_by_email: 'up@lab.org',
			});
		});

		it('a capture from before recorder stamping falls back to server defaults', async () => {
			await uploadCaptureColdStart({ ...BASE_INFO, cfg: { source: 'nidaq', extra_metadata: {} } });
			const payload = post.mock.calls.find(([url]) => url === '/items/manufacturing_operations')![1];
			expect(payload.owner_person_id).toBeNull(); // null -> d1-default-owner fills it
			expect(Date.parse(payload.operation_date)).toBeGreaterThan(Date.parse('2026-09-29T00:00:00Z'));
		});

		it('refuses from an offline session, without calling the server', async () => {
			auth.state.offline = true; auth.state.accessToken = null; auth.state.refreshToken = null;
			await expect(uploadCaptureColdStart({ ...BASE_INFO, cfg: { source: 'nidaq', extra_metadata: {} } }))
				.rejects.toThrow(/signed in offline/i);
			expect(post).not.toHaveBeenCalled();
		});
	});
});

// Review 2.2: a retry resumes instead of inserting a second operation row.
describe('uploadCaptureColdStart resume', () => {
	const info = { ...BASE_INFO, cfg: { source: 'nidaq', extra_metadata: {} } };
	const count = (url: string) => post.mock.calls.filter(([u]) => u === url).length;

	it('a failed analysis insert is retried without a second operation row or file uploads', async () => {
		let fail = true;
		post.mockImplementation((url: string) => {
			if (url === '/items/manufacturing_operations') return Promise.resolve({ data: { data: { operation_id: 'op-9' } } });
			if (url === '/files') return Promise.resolve({ data: { data: { id: 'file-1' } } });
			if (fail) return Promise.reject(Object.assign(new Error('x'), { response: { status: 500 } }));
			return Promise.resolve({ data: { data: {} } });
		});
		await expect(uploadCaptureColdStart(info)).rejects.toThrow(/linking the capture failed/);
		fail = false;
		await expect(uploadCaptureColdStart(info)).resolves.toBe('op-9');
		expect(count('/items/manufacturing_operations')).toBe(1);
		expect(count('/files')).toBe(2);
		expect(count('/items/machining_force_analysis')).toBe(2);
	});

	it('reuses an operation already stamped with this capture id (a reply lost earlier)', async () => {
		get.mockImplementation(async (url: string) => (url === '/items/manufacturing_operations'
			? { data: { data: [{ operation_id: 'op-old', recorded_metadata: { capture_id: 'cap-1' } }] } }
			: { data: { data: [] } }));
		await expect(uploadCaptureColdStart(info)).resolves.toBe('op-old');
		expect(count('/items/manufacturing_operations')).toBe(0);
		expect(post.mock.calls.find(([u]) => u === '/items/machining_force_analysis')![1].operation_id).toBe('op-old');
	});
});

// Review: an existing analysis row that lacks a file link is completed, not skipped.
describe('uploadCaptureColdStart with a partial analysis row already in the database', () => {
	const info = { ...BASE_INFO, matWritten: true, cfg: { source: 'nidaq', extra_metadata: {} } };
	const count = (url: string) => post.mock.calls.filter(([u]) => u === url).length;
	const patch = patchFn;
	beforeEach(() => { patch.mockReset(); patch.mockResolvedValue({ data: { data: {} } }); });
	function seed(row: Record<string, unknown> | null) {
		get.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: [{ operation_id: 'op-old', recorded_metadata: { capture_id: 'cap-1' } }] } };
			if (url === '/items/machining_force_analysis') return { data: { data: row ? [{ id: 'a-1', ...row }] : [] } };
			return { data: { data: [] } };
		});
	}

	it('PATCHes only the missing .mat link: no second row, no cache re-upload', async () => {
		seed({ live_cache_file: 'cache-present', directus_files_id: null });
		await expect(uploadCaptureColdStart(info)).resolves.toBe('op-old');
		expect(count('/items/machining_force_analysis')).toBe(0);
		expect(count('/files')).toBe(1);
		expect(patch).toHaveBeenCalledWith('/items/machining_force_analysis/a-1', { directus_files_id: 'file-1' });
	});

	it('PATCHes only the missing cache link, keeping a present .mat link', async () => {
		seed({ live_cache_file: null, directus_files_id: 'mat-present' });
		await uploadCaptureColdStart(info);
		expect(count('/items/machining_force_analysis')).toBe(0);
		expect(count('/files')).toBe(1);
		expect(patch).toHaveBeenCalledWith('/items/machining_force_analysis/a-1', { live_cache_file: 'file-1' });
	});

	it('a complete row: no files uploaded, nothing written', async () => {
		seed({ live_cache_file: 'c', directus_files_id: 'm' });
		await expect(uploadCaptureColdStart(info)).resolves.toBe('op-old');
		expect(count('/files')).toBe(0);
		expect(count('/items/machining_force_analysis')).toBe(0);
		expect(patch).not.toHaveBeenCalled();
	});

	it('a capture with no .mat is complete with just the cache link', async () => {
		seed({ live_cache_file: 'c', directus_files_id: null });
		await uploadCaptureColdStart({ ...info, matWritten: false });
		expect(count('/files')).toBe(0);
		expect(patch).not.toHaveBeenCalled();
	});

	it('no existing row: still posts one', async () => {
		seed(null);
		await uploadCaptureColdStart(info);
		expect(count('/items/machining_force_analysis')).toBe(1);
		expect(patch).not.toHaveBeenCalled();
	});

	it('a failed lookup of the existing row stops the upload instead of risking a second row', async () => {
		get.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: [{ operation_id: 'op-old', recorded_metadata: { capture_id: 'cap-1' } }] } };
			if (url === '/items/machining_force_analysis') throw Object.assign(new Error('timeout'), { response: { status: 503 } });
			return { data: { data: [] } };
		});
		await expect(uploadCaptureColdStart(info)).rejects.toThrow(/could not check/);
		expect(count('/files')).toBe(0);
		expect(count('/items/machining_force_analysis')).toBe(0);
	});

	it('with two rows from an older race, adopts the more complete one', async () => {
		get.mockImplementation(async (url: string) => {
			if (url === '/items/manufacturing_operations') return { data: { data: [{ operation_id: 'op-old', recorded_metadata: { capture_id: 'cap-1' } }] } };
			if (url === '/items/machining_force_analysis') return { data: { data: [
				{ id: 'a-partial', live_cache_file: null, directus_files_id: null },
				{ id: 'a-full', live_cache_file: 'c', directus_files_id: 'm' },
			] } };
			return { data: { data: [] } };
		});
		await uploadCaptureColdStart(info);
		expect(count('/files')).toBe(0);
		expect(patch).not.toHaveBeenCalled();
	});

	it('a failed PATCH surfaces as a linking error', async () => {
		seed({ live_cache_file: 'c', directus_files_id: null });
		patch.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 500 } }));
		await expect(uploadCaptureColdStart(info)).rejects.toThrow(/linking the capture failed/);
	});
});

// #190: the crop the operator set survives into the analysis row of a retried / cold-start upload.
describe('uploadCaptureColdStart crop override', () => {
	const base = { ...BASE_INFO, cacheUrl: 'http://x/captures/cap-1/live_cache.bin', matWritten: false, cfg: { source: 'nidaq', extra_metadata: {} } };
	const analysisBody = () => post.mock.calls.find(([u]) => u === '/items/machining_force_analysis')![1];

	it('sends the override the summary holds', async () => {
		await uploadCaptureColdStart({ ...base, summary: { fs: 51200, crop_start_idx_override: 1000, crop_end_idx_override: 36_000_000 } });
		expect(analysisBody()).toMatchObject({ crop_start_idx_override: 1000, crop_end_idx_override: 36_000_000 });
	});

	it('does not fetch the summary again, and sends no override without one', async () => {
		const fetchMock = vi.fn(async (_url: string) => ({ ok: true, blob: async () => new Blob(['x']) }));
		vi.stubGlobal('fetch', fetchMock);
		await uploadCaptureColdStart({ ...base, summary: { fs: 51200 } });
		expect(analysisBody()).not.toHaveProperty('crop_start_idx_override');
		expect(analysisBody()).not.toHaveProperty('crop_end_idx_override');
		expect(fetchMock.mock.calls.some(([u]) => u.endsWith('/summary'))).toBe(false);
	});

	it('sends no override for a half-set pair', async () => {
		await uploadCaptureColdStart({ ...base, summary: { crop_start_idx_override: 5 } });
		expect(analysisBody()).not.toHaveProperty('crop_start_idx_override');
		expect(analysisBody()).not.toHaveProperty('crop_end_idx_override');
	});

	it('sends no override when the caller passes no summary', async () => {
		await uploadCaptureColdStart(base);
		expect(analysisBody()).not.toHaveProperty('crop_start_idx_override');
	});
});

// #190: the error text must not claim "both files uploaded" when the .mat was skipped.
describe('uploadCaptureColdStart failure text for the analysis insert', () => {
	const failAnalysis = () => post.mockImplementation((url: string) => {
		if (url === '/items/manufacturing_operations') return Promise.resolve({ data: { data: { operation_id: 'op-9' } } });
		if (url === '/files') return Promise.resolve({ data: { data: { id: 'file-1' } } });
		return Promise.reject(Object.assign(new Error('x'), { response: { status: 400, data: { errors: [{ message: 'Value can\'t be null' }] } } }));
	});

	it('says the .mat was skipped (over the size limit) when mat_written is false', async () => {
		failAnalysis();
		const err = await uploadCaptureColdStart({ ...BASE_INFO, matWritten: false, cfg: { source: 'nidaq', extra_metadata: {} } }).catch((e) => e);
		expect(err.message).toMatch(/linking the capture failed - 400/);
		expect(err.message).toMatch(/size limit/);
		expect(err.message).not.toMatch(/both files/);
	});

	it('still says both files uploaded when a .mat was written', async () => {
		failAnalysis();
		const err = await uploadCaptureColdStart({ ...BASE_INFO, matWritten: true, cfg: { source: 'nidaq', extra_metadata: {} } }).catch((e) => e);
		expect(err.message).toMatch(/both files uploaded/);
	});
});

// #194: a multi-GB .mat failing to read or upload must not take the live cache down with it.
describe('uploadCaptureColdStart when the .mat fails', () => {
	const info = { ...BASE_INFO, matWritten: true, cfg: { source: 'nidaq', extra_metadata: {} } };
	const filesPosted = () => post.mock.calls.filter(([u]) => u === '/files').map(([, fd]) => (fd as FormData).get('file') as File);
	const analysisPosts = () => post.mock.calls.filter(([u]) => u === '/items/machining_force_analysis');
	beforeEach(() => { patchFn.mockReset(); patchFn.mockResolvedValue({ data: { data: {} } }); });

	it('a .mat fetch that rejects still uploads the cache and creates the row with a null file', async () => {
		vi.stubGlobal('fetch', vi.fn((url: string) => (url.endsWith('.mat')
			? Promise.reject(new Error('capture.mat fetch failed'))
			: Promise.resolve({ ok: true, blob: async () => new Blob(['x']) }))));
		const err = await uploadCaptureColdStart(info).catch((e) => e);
		expect(err.message).toMatch(/the \.mat/);
		expect(err.message).toMatch(/kept locally/);
		expect(err.message).toMatch(/Retry upload/);
		expect(filesPosted().map((f) => f.name)).toEqual(['cap-1_live_cache.bin']);
		expect(analysisPosts()).toHaveLength(1);
		expect(analysisPosts()[0][1]).toMatchObject({ operation_id: 'op-123', directus_files_id: null, live_cache_file: 'file-1' });
	});

	it('a .mat upload that fails is reported with its size, and the cache is in', async () => {
		vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ ok: true, blob: async () => new Blob([url.endsWith('.mat') ? 'x'.repeat(2048) : 'x']) })));
		post.mockImplementation((url: string, body: any) => {
			if (url === '/items/manufacturing_operations') return Promise.resolve({ data: { data: { operation_id: 'op-123' } } });
			if (url === '/files') {
				return (body.get('file') as File).name.endsWith('.mat')
					? Promise.reject(Object.assign(new Error('x'), { response: { status: 413 } }))
					: Promise.resolve({ data: { data: { id: 'cache-1' } } });
			}
			return Promise.resolve({ data: { data: {} } });
		});
		const err = await uploadCaptureColdStart(info).catch((e) => e);
		expect(err.message).toMatch(/the \.mat \(1 MB\) didn't upload/);
		expect(analysisPosts()[0][1]).toMatchObject({ directus_files_id: null, live_cache_file: 'cache-1' });
	});

	it('Retry upload sends only the .mat and PATCHes it onto the existing row', async () => {
		let matFails = true;
		vi.stubGlobal('fetch', vi.fn((url: string) => (url.endsWith('.mat') && matFails
			? Promise.reject(new Error('capture.mat fetch failed'))
			: Promise.resolve({ ok: true, blob: async () => new Blob(['x']) }))));
		await expect(uploadCaptureColdStart(info)).rejects.toThrow(/the \.mat/);
		matFails = false;
		// The row the first attempt created, as the lookup finds it.
		get.mockImplementation(async (url: string) => (url === '/items/machining_force_analysis'
			? { data: { data: [{ id: 'a-1', live_cache_file: 'file-1', directus_files_id: null }] } }
			: { data: { data: [] } }));
		post.mockClear();
		await expect(uploadCaptureColdStart(info)).resolves.toBe('op-123');
		expect(filesPosted().map((f) => f.name)).toEqual(['cap-1.mat']);
		expect(analysisPosts()).toHaveLength(0);
		expect(patchFn).toHaveBeenCalledWith('/items/machining_force_analysis/a-1', { directus_files_id: 'file-1' });
		// And it is now done: a further retry does nothing.
		post.mockClear();
		await expect(uploadCaptureColdStart(info)).resolves.toBe('op-123');
		expect(post).not.toHaveBeenCalled();
	});

	it('a failed analysis insert after a failed .mat says the .mat did not upload', async () => {
		vi.stubGlobal('fetch', vi.fn((url: string) => (url.endsWith('.mat')
			? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true, blob: async () => new Blob(['x']) }))));
		post.mockImplementation((url: string) => {
			if (url === '/items/manufacturing_operations') return Promise.resolve({ data: { data: { operation_id: 'op-9' } } });
			if (url === '/files') return Promise.resolve({ data: { data: { id: 'file-1' } } });
			return Promise.reject(Object.assign(new Error('x'), { response: { status: 500 } }));
		});
		const err = await uploadCaptureColdStart(info).catch((e) => e);
		expect(err.message).toMatch(/linking the capture failed/);
		expect(err.message).toMatch(/\.mat did not upload/);
		expect(err.message).not.toMatch(/both files/);
	});

	it('a failed cache upload still fails the upload (the row is useless without it)', async () => {
		post.mockImplementation((url: string) => {
			if (url === '/items/manufacturing_operations') return Promise.resolve({ data: { data: { operation_id: 'op-9' } } });
			if (url === '/files') return Promise.reject(Object.assign(new Error('x'), { response: { status: 500 } }));
			return Promise.resolve({ data: { data: {} } });
		});
		await expect(uploadCaptureColdStart(info)).rejects.toThrow(/live_cache\.bin|file upload/);
		expect(analysisPosts()).toHaveLength(0);
	});
});
