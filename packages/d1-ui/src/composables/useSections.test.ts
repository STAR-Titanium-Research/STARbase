import { describe, expect, it } from 'vitest';
import { LIST_CAP, useSections } from './useSections';
import { useRequestGate } from './useRequestGate';

const setup = () => {
	const gate = useRequestGate();
	return { gate, ...useSections(gate) };
};

describe('useSections', () => {
	it('starts with the initial data, optionally loading', () => {
		const { section } = setup();
		expect(section<number[]>([]).value).toEqual({ data: [], loading: false, error: '' });
		expect(section<number[]>([], true).value.loading).toBe(true);
	});

	it('fills a section and clears the loading flag', async () => {
		const { gate, section, fill } = setup();
		const s = section<number[]>([]);
		const done = fill(s, gate.begin(), 'rows', async () => [1, 2]);
		expect(s.value.loading).toBe(true);
		await done;
		expect(s.value).toEqual({ data: [1, 2], loading: false, error: '' });
	});

	it('keeps the last data and shows the error when a reload fails', async () => {
		const { gate, section, fill } = setup();
		const s = section<number[]>([]);
		await fill(s, gate.begin(), 'rows', async () => [1, 2]);
		await fill(s, gate.begin(), 'rows', async () => {
			throw Object.assign(new Error('x'), { response: { data: { errors: [{ message: 'boom' }] } } });
		});
		expect(s.value.data).toEqual([1, 2]);
		expect(s.value.error).toBe('Could not load rows: boom');
		expect(s.value.loading).toBe(false);
		// and the next good load clears the error
		await fill(s, gate.begin(), 'rows', async () => [3]);
		expect(s.value).toEqual({ data: [3], loading: false, error: '' });
	});

	it('drops an answer that was replaced by a newer request', async () => {
		const { gate, section, fill } = setup();
		const s = section<string>('');
		const old = gate.begin();
		const slow = fill(s, old, 'x', async () => 'old');
		await fill(s, gate.begin(), 'x', async () => 'new');
		await slow;
		expect(s.value.data).toBe('new');
	});

	it('drops a stale failure too', async () => {
		const { gate, section, fill } = setup();
		const s = section<string>('kept');
		const token = gate.begin();
		const p = fill(s, token, 'x', async () => {
			throw new Error('late');
		});
		gate.cancel();
		await p;
		expect(s.value.error).toBe('');
		expect(s.value.data).toBe('kept');
	});

	it('lets the caller turn a failure into a state of its own', async () => {
		const { gate, section, fill } = setup();
		const s = section<number[]>([]);
		let unavailable = false;
		await fill(s, gate.begin(), 'rows', async () => {
			throw new Error('forbidden');
		}, () => ((unavailable = true), true));
		expect(unavailable).toBe(true);
		expect(s.value).toEqual({ data: [], loading: false, error: '' });
	});

	it('caps lists at 200', () => {
		expect(LIST_CAP).toBe(200);
	});
});
