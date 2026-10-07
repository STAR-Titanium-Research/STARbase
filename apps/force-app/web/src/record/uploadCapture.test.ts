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

import { uploadCaptureColdStart } from './uploadCapture';
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
