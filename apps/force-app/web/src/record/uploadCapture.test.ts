import { beforeEach, describe, expect, it, vi } from 'vitest';

// api.post is the seam for the manufacturing_operations insert AND the two file uploads (/files);
// api.get isn't used by this path. The .mat/live_cache fetches go through global fetch.
const post = vi.fn();
vi.mock('../directusClient', () => ({ api: { post: (...a: unknown[]) => post(...a) } }));
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

function mockFetchOk() {
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) }));
}

beforeEach(() => {
	auth.state.offline = false;
	auth.state.user = { id: 'u-uploader', email: 'up@lab.org' };
	post.mockReset();
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
