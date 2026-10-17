// The record page's imaging settings of one file, against the fake d1-inbox (its sem-settings routes): the owner edits, others read, a locked or
// missing file is locked, a stale answer for a file the page has moved on from is dropped.
import { describe, expect, it } from 'vitest';
import { createFakeInbox } from './fakeInboxServer';
import { createSemSettings } from './useSemSettings';

const A = '00000000-0000-4000-8000-00000000a001';
const B = '00000000-0000-4000-8000-00000000b001';
const SETTINGS = { kv: 15, spot: 3, working_distance_mm: 8.5, magnification: 5000, scale_bar_um: 10, detector: 'ETD', acquired_at: '2026-03-02T10:15:30.000Z' };
const owned = { locked: false as const, settings: SETTINGS, sources: { kv: 'metadata', magnification: 'derived' }, flags: { check_this: true }, can_edit: true };

const make = (id: () => string = () => A) => {
	const fake = createFakeInbox({ sem: { [A]: owned, [B]: { locked: false, settings: null }, '00000000-0000-4000-8000-00000000c001': { locked: true } } });
	return { fake, s: createSemSettings(fake.api, id) };
};

describe('the fake d1-inbox sem-settings routes', () => {
	it('answers an owner, a file with none, a locked file and a file it does not know (locked)', async () => {
		const { fake } = make();
		expect((await fake.api.get('/d1-inbox/sem-settings', { params: { file: A } })).data.data).toMatchObject({ locked: false, can_edit: true });
		expect((await fake.api.get('/d1-inbox/sem-settings', { params: { file: B } })).data.data).toEqual({ locked: false, settings: null });
		expect((await fake.api.get('/d1-inbox/sem-settings', { params: { file: '00000000-0000-4000-8000-00000000c001' } })).data.data).toEqual({ locked: true });
		expect((await fake.api.get('/d1-inbox/sem-settings', { params: { file: '00000000-0000-4000-8000-00000000dead' } })).data.data).toEqual({ locked: true });
	});

	it('refuses a correction like the server: 400 for a field or a value, 403 for a file the caller cannot change', async () => {
		const { fake } = make();
		const patch = (file: string, body: unknown) => fake.api.patch(`/d1-inbox/sem-settings/${file}`, body).catch((e) => e.response);
		expect(await patch(A, { field: 'read_by', value: 'x' })).toMatchObject({ status: 400, data: { errors: [{ extensions: { field: 'field', code: 'INVALID_PAYLOAD' } }] } });
		expect(await patch(A, { field: 'kv', value: 99 })).toMatchObject({ status: 400, data: { errors: [{ extensions: { field: 'value' } }] } });
		expect(await patch(A, { field: 'magnification', value: 5000.5 })).toMatchObject({ status: 400 });
		expect(await patch(A, { field: 'kv', value: 20, extra: 1 })).toMatchObject({ status: 400 });
		expect(await patch(B, { field: 'kv', value: 20 })).toMatchObject({ status: 403 });
		expect(await patch('00000000-0000-4000-8000-00000000dead', { field: 'kv', value: 20 })).toMatchObject({ status: 403 });
	});

	it('a correction answers the settings again with the field manual and its flag gone', async () => {
		const { fake } = make();
		const res = await fake.api.patch(`/d1-inbox/sem-settings/${A}`, { field: 'kv', value: 20 });
		expect(res.data.data).toMatchObject({ locked: false, can_edit: true, settings: { kv: 20, spot: 3 }, sources: { kv: 'manual', magnification: 'derived' } });
	});
});

describe('createSemSettings', () => {
	it('loads, then edits through the draft and shows the field as manual', async () => {
		const { fake, s } = make();
		expect(s.state.value).toBe('loading');
		await s.load();
		expect(s.state.value).toBe('settings');
		s.start('kv');
		s.draft.value = '20';
		await s.save();
		expect(s.rows.value.find((r) => r.key === 'kv')).toMatchObject({ text: '20 kV', source: 'manual' });
		expect(fake.calls.at(-1)).toMatchObject({ method: 'patch', body: { field: 'kv', value: 20 } });
	});

	it('gives the owner a row for every setting, the unset ones to fill in', async () => {
		const { s } = make();
		await s.load();
		expect(s.rows.value).toHaveLength(11);
		expect(s.rows.value.find((r) => r.key === 'instrument')).toMatchObject({ text: null, failed: null });
	});

	it('moves a started edit back when another one starts, and one at a time', async () => {
		const { s } = make();
		await s.load();
		s.start('kv');
		s.draft.value = '9';
		s.start('spot');
		expect(s.editing.value).toBe('spot');
		expect(s.draft.value).toBe('3');
	});

	it('drops the answer of a file the page has moved on from', async () => {
		let id = A;
		const { s } = make(() => id);
		const first = s.load();
		id = B;
		await s.load();
		await first;
		expect(s.state.value).toBe('none');
	});

	it('says the call failed without losing the page (state error, a message)', async () => {
		const { fake } = make();
		const s = createSemSettings({ ...fake.api, get: () => Promise.reject(new Error('Network Error')) }, () => A);
		await s.load();
		expect(s.state.value).toBe('error');
		expect(s.error.value).not.toBe('');
	});
});
