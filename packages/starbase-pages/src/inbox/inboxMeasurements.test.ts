// The saved-measurement calls (inboxApi.ts) and the list they feed (useMeasurements.ts), against the fake d1-inbox: what the client sends is what the endpoint's
// own validators accept (core/extensions/d1-inbox/index.js parseMeasurement; the fake repeats them), what it reads is tolerant, and the list stays in step.
import { describe, expect, it } from 'vitest';
import { InboxApiError, deleteMeasurement, loadMeasurements, parseMeasurement, renameMeasurement, saveMeasurement, type SavedMeasurement } from './inboxApi';
import { createFakeInbox, foundFile } from './fakeInboxServer';
import { createMeasurements } from './useMeasurements';

const LINE = { kind: 'line' as const, points: [{ x: 100, y: 200 }, { x: 400, y: 600 }] };
const POLY = { kind: 'polygon' as const, points: [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 60, y: 90 }], label: 'grain A' };

const setup = (opts = {}) => {
	const file = foundFile();
	const fake = createFakeInbox({ files: [file], ...opts });
	return { file, fake, id: file.candidate_id };
};
const refusal = async (p: Promise<unknown>): Promise<InboxApiError> => {
	try {
		await p;
	} catch (e) {
		return e as InboxApiError;
	}
	throw new Error('was not refused');
};

describe('the calls', () => {
	it('save a shape (original pixels), list it, rename it and delete it, on the file\'s own paths', async () => {
		const { fake, id } = setup();
		const a = await saveMeasurement(fake.api, id, LINE);
		expect(a).toMatchObject({ kind: 'line', points: LINE.points, label: '', author_name: 'Ann Lee', can_edit: true });
		await saveMeasurement(fake.api, id, POLY);
		const got = await loadMeasurements(fake.api, id);
		expect(got.canChange).toBe(true);
		expect(got.measurements.map((m) => [m.kind, m.label])).toEqual([['line', ''], ['polygon', 'grain A']]);
		const renamed = await renameMeasurement(fake.api, id, a.measurement_id, 'edge');
		expect(renamed.label).toBe('edge');
		await deleteMeasurement(fake.api, id, a.measurement_id);
		expect((await loadMeasurements(fake.api, id)).measurements.map((m) => m.kind)).toEqual(['polygon']);
		expect(fake.calls.map((c) => `${c.method} ${c.path.replace(id, ':id').replace(a.measurement_id, ':m')}`)).toEqual([
			'post /d1-inbox/files/:id/measurements', 'post /d1-inbox/files/:id/measurements', 'get /d1-inbox/files/:id/measurements',
			'patch /d1-inbox/files/:id/measurements/:m', 'delete /d1-inbox/files/:id/measurements/:m', 'get /d1-inbox/files/:id/measurements',
		]);
		expect(fake.calls[3].body).toEqual({ label: 'edge' }); // exactly the one key
		expect(fake.calls[0].body).toEqual(LINE);
	});

	it('say what the server said: a refused shape names the field, a full file and a read-only caller have their own words and codes', async () => {
		const { fake, id } = setup();
		const bad = await refusal(saveMeasurement(fake.api, id, { kind: 'line', points: [{ x: 1, y: 1 }, { x: 1, y: 1 }] }));
		expect(bad).toBeInstanceOf(InboxApiError);
		expect(bad.status).toBe(400);
		expect(bad.extensions?.field).toBe('points');
		expect(bad.message).toBe('The two points are on the same spot.');
		const label = await refusal(renameMeasurement(fake.api, id, (await saveMeasurement(fake.api, id, LINE)).measurement_id, 'x'.repeat(121)));
		expect(label.extensions?.field).toBe('label');
		const read = setup({ measureReadOnly: true });
		const denied = await refusal(saveMeasurement(read.fake.api, read.id, LINE));
		expect([denied.status, denied.code]).toEqual([403, 'FORBIDDEN']);
		const gone = await refusal(loadMeasurements(read.fake.api, 'c0000000-0000-4000-8000-000000000000'));
		expect([gone.status, gone.code]).toEqual([404, 'NOT_FOUND']);
		expect((await loadMeasurements(read.fake.api, read.id)).canChange).toBe(false);
	});

	it('read a row tolerantly: an unknown kind, a missing id or a corner that is not a number is left out, never thrown on; can_edit is true only when it is exactly true', () => {
		const good = { measurement_id: 'm1', kind: 'circle', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], label: 'pore', created_at: '2026-10-22T10:00:00.000Z', author_name: 'Ann Lee', can_edit: true };
		expect(parseMeasurement(good)).toEqual(good);
		expect(parseMeasurement({ ...good, can_edit: 'yes' })?.can_edit).toBe(false);
		expect(parseMeasurement({ ...good, label: undefined })?.label).toBe('');
		for (const bad of [null, 5, {}, { ...good, measurement_id: 5 }, { ...good, kind: 'spline' }, { ...good, points: 'x' }, { ...good, points: [{ x: 1, y: 'a' }, { x: 1, y: 2 }] }, { ...good, points: [{ x: 1, y: NaN }, { x: 1, y: 2 }] }, { ...good, points: [null, { x: 1, y: 2 }] }]) {
			expect(parseMeasurement(bad), JSON.stringify(bad)).toBeNull();
		}
	});

	it('encode ids in the path, and an answer that cannot be read is an error that says to reload', async () => {
		const calls: string[] = [];
		const api = {
			get: async () => ({ data: { data: [{ measurement_id: 'a' }, { measurement_id: 'b', kind: 'line', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }], meta: { total: 2, can_change: true } } }),
			post: async (path: string) => (calls.push(path), { data: { data: { nope: true } } }),
			patch: async (path: string) => (calls.push(path), { data: { data: {} } }),
			delete: async (path: string) => (calls.push(path), { data: {} }),
		};
		expect((await loadMeasurements(api, 'x')).measurements.map((m) => m.measurement_id)).toEqual(['b']);
		expect((await refusal(saveMeasurement(api, 'a/b', LINE))).message).toMatch(/Reload the list/);
		expect((await refusal(renameMeasurement(api, 'a', 'm/1', 'x'))).message).toMatch(/Reload the list/);
		await deleteMeasurement(api, 'a', 'm 1');
		expect(calls).toEqual(['/d1-inbox/files/a%2Fb/measurements', '/d1-inbox/files/a/measurements/m%2F1', '/d1-inbox/files/a/measurements/m%201']);
	});

	it('do not send what the server does not take: the body of a save is kind, points and (when given) label', async () => {
		const { fake, id } = setup();
		await saveMeasurement(fake.api, id, POLY);
		expect(Object.keys(fake.calls[0].body as object).sort()).toEqual(['kind', 'label', 'points']);
		expect(fake.measurements.get(id)).toHaveLength(1);
	});
});

describe('the list', () => {
	const seeded = (n: number): SavedMeasurement => ({
		measurement_id: `s${n}`, kind: 'line', points: [{ x: 0, y: 0 }, { x: n * 10, y: 0 }], label: '', created_at: `2026-10-22T09:00:0${n}.000Z`, author_name: 'Bo Chan', can_edit: n !== 2,
	});

	it('loads a file\'s shapes in order and says whether a shape may be added', async () => {
		const { fake, id } = setup({ measurements: { '': [] } });
		fake.measurements.set(id, [seeded(2), seeded(1)]);
		const m = createMeasurements(fake.api);
		expect(m.status.value).toBe('idle');
		const loading = m.load(id);
		expect(m.status.value).toBe('loading');
		await loading;
		expect(m.status.value).toBe('ready');
		expect(m.list.value.map((x) => x.measurement_id)).toEqual(['s1', 's2']);
		expect(m.canChange.value).toBe(true);
	});

	it('save adds the new shape in its place and selects it; rename and delete follow the server; a delete of the selected shape clears the selection', async () => {
		const { fake, id } = setup();
		const m = createMeasurements(fake.api);
		await m.load(id);
		expect(await m.save(LINE)).toEqual({ ok: true });
		expect(m.list.value).toHaveLength(1);
		const first = m.list.value[0].measurement_id;
		expect(m.selectedId.value).toBe(first);
		await m.save(POLY);
		expect(m.list.value.map((x) => x.kind)).toEqual(['line', 'polygon']);
		expect(m.selectedId.value).toBe(m.list.value[1].measurement_id);
		expect(await m.rename(first, 'edge')).toEqual({ ok: true });
		expect(m.list.value[0].label).toBe('edge');
		m.select(first);
		expect(m.selectedId.value).toBe(first);
		expect(await m.remove(first)).toEqual({ ok: true });
		expect(m.list.value.map((x) => x.kind)).toEqual(['polygon']);
		expect(m.selectedId.value).toBeNull();
		expect(m.busy.value).toBeNull();
	});

	it('select toggles, takes only a shape in the list, and null clears', async () => {
		const { fake, id } = setup();
		fake.measurements.set(id, [seeded(1), seeded(3)]);
		const m = createMeasurements(fake.api);
		await m.load(id);
		m.select('s1');
		expect(m.selectedId.value).toBe('s1');
		m.select('s1');
		expect(m.selectedId.value).toBeNull();
		m.select('s3');
		m.select('nope');
		expect(m.selectedId.value).toBeNull();
		m.select('s3');
		m.select(null);
		expect(m.selectedId.value).toBeNull();
	});

	it('a refused change keeps the list as it was and says why; a refused rename of a shape the person may not change is the server\'s words', async () => {
		const { fake, id } = setup();
		fake.measurements.set(id, [seeded(1), seeded(2)]);
		const m = createMeasurements(fake.api);
		await m.load(id);
		const out = await m.rename('s2', 'mine');
		expect(out.ok).toBe(false);
		expect(m.error.value).toBe('Only the owner of the file or the person who saved a measurement can change it.');
		expect(m.list.value.map((x) => x.label)).toEqual(['', '']);
		const full = await m.save({ kind: 'line', points: [{ x: 3, y: 3 }, { x: 3, y: 3 }] });
		expect(full).toEqual({ ok: false, message: 'The two points are on the same spot.' });
		expect(m.list.value).toHaveLength(2);
		expect(m.busy.value).toBeNull();
	});

	it('a read that fails leaves an empty list and the reason, and the next file starts clean', async () => {
		const { fake, id } = setup({ measureFails: true });
		const m = createMeasurements(fake.api);
		await m.load(id);
		expect(m.status.value).toBe('error');
		expect(m.error.value).toBe('Something went wrong on the server.');
		expect(m.list.value).toEqual([]);
		await m.load(null);
		expect(m.status.value).toBe('idle');
		expect(m.error.value).toBe('');
	});

	it('drops an answer that arrives after another file was opened (no shape of the old file shows on the new one)', async () => {
		const a = foundFile();
		const b = foundFile();
		const fake = createFakeInbox({ files: [a, b] });
		fake.measurements.set(a.candidate_id, [seeded(1)]);
		fake.measurements.set(b.candidate_id, [seeded(2)]);
		let release: (() => void) | null = null;
		const slow = { ...fake.api, get: (path: string, c?: any) => (path.includes(a.candidate_id) ? new Promise<any>((res) => (release = () => res(fake.api.get(path, c)))) : fake.api.get(path, c)) };
		const m = createMeasurements(slow);
		const first = m.load(a.candidate_id);
		await m.load(b.candidate_id);
		expect(m.list.value.map((x) => x.measurement_id)).toEqual(['s2']);
		release!();
		await first;
		expect(m.list.value.map((x) => x.measurement_id)).toEqual(['s2']);
		expect(m.status.value).toBe('ready');
	});

	it('ignores the answer of a change to a file that is no longer open', async () => {
		const a = foundFile();
		const b = foundFile();
		const fake = createFakeInbox({ files: [a, b] });
		let release: (() => void) | null = null;
		const slow = { ...fake.api, post: (path: string, body?: unknown) => new Promise<any>((res) => (release = () => res(fake.api.post(path, body)))) };
		const m = createMeasurements(slow);
		await m.load(a.candidate_id);
		const pending = m.save(LINE);
		await m.load(b.candidate_id);
		release!();
		expect(await pending).toEqual({ ok: true });
		expect(m.list.value).toEqual([]);
		expect(m.busy.value).toBeNull();
		expect(fake.measurements.get(a.candidate_id)).toHaveLength(1); // it was saved on the file it was drawn on
	});

	it('does one change at a time', async () => {
		const { fake, id } = setup();
		const m = createMeasurements(fake.api);
		await m.load(id);
		const [x, y] = await Promise.all([m.save(LINE), m.save(POLY)]);
		expect(x).toEqual({ ok: true });
		expect(y.ok).toBe(false);
		expect(m.list.value).toHaveLength(1);
	});

	it('has nothing to change with no file open', async () => {
		const { fake } = setup();
		const m = createMeasurements(fake.api);
		expect((await m.save(LINE)).ok).toBe(false);
	});
});
