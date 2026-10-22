import { describe, expect, it } from 'vitest';
import { MAX_RECENTS, isRecentable, pushRecent, readFolded, readRecents, recentIdOf, writeFolded } from './recents';

/** A Storage that keeps what it is given (node has none). */
function memory(): Storage {
	const m = new Map<string, string>();
	return {
		get length() {
			return m.size;
		},
		clear: () => m.clear(),
		getItem: (k) => m.get(k) ?? null,
		key: (i) => [...m.keys()][i] ?? null,
		removeItem: (k) => void m.delete(k),
		setItem: (k, v) => void m.set(k, String(v)),
	};
}
const blocked = (): Storage => {
	const fail = () => {
		throw new Error('blocked');
	};
	return { length: 0, clear: fail, getItem: fail, key: fail, removeItem: fail, setItem: fail };
};

describe('recents', () => {
	it('puts the newest first, keeps each once, and keeps six', () => {
		const s = memory();
		for (const id of ['op:a', 'op:b', 'test:t', 'op:a']) pushRecent('u1', id, s);
		expect(readRecents('u1', s)).toEqual(['op:a', 'test:t', 'op:b']);
		for (let i = 0; i < 10; i++) pushRecent('u1', `op:${i}`, s);
		expect(readRecents('u1', s)).toHaveLength(MAX_RECENTS);
		expect(readRecents('u1', s)[0]).toBe('op:9');
	});

	it('is one list per person', () => {
		const s = memory();
		pushRecent('u1', 'op:a', s);
		expect(readRecents('u2', s)).toEqual([]);
	});

	it('reads nothing from a broken value or blocked storage, and still answers a push', () => {
		const s = memory();
		s.setItem('d1.map.add.recent.v1.u1', '{nope');
		expect(readRecents('u1', s)).toEqual([]);
		expect(readRecents('u1', blocked())).toEqual([]);
		expect(pushRecent('u1', 'op:a', blocked())).toEqual(['op:a']);
		expect(readRecents('u1', null)).toEqual([]);
	});

	it('remembers only what the catalog adds', () => {
		expect(['op:1', 'test:x', 'sample:new', 'sample:same', 'connect', 'canvas:n1'].map((id) => isRecentable({ id }))).toEqual([true, true, true, false, false, false]);
	});
});

describe('which choice is remembered as what', () => {
	it('a method, a test type and a new sample; not the sub-choices of a socket', () => {
		expect(recentIdOf({ kind: 'operation', methodId: 'm1', category: null })).toBe('op:m1');
		expect(recentIdOf({ kind: 'test', testType: 'xrd' })).toBe('test:xrd');
		expect(recentIdOf({ kind: 'newSample' })).toBe('sample:new');
		// The palette's Operation and Test (blank cards) are no method or type to come back to.
		expect(recentIdOf({ kind: 'newOperation' })).toBeNull();
		expect(recentIdOf({ kind: 'newTest' })).toBeNull();
		// A template is its own group at the top, not a recent.
		expect(recentIdOf({ kind: 'operation', methodId: 'm1', category: null, template: { id: 't1', values: {} } })).toBeNull();
		expect(recentIdOf({ kind: 'test', testType: 'xrd', template: { id: 't1', values: {} } })).toBeNull();
		for (const kind of ['sameSample', 'existingSample', 'pickSamples', 'connectTo'] as const) expect(recentIdOf({ kind })).toBeNull();
		expect(recentIdOf({ kind: 'wireSample', key: 'n1' })).toBeNull();
	});
});

describe('the folded palette', () => {
	it('is open until someone folds it, per person', () => {
		const s = memory();
		expect(readFolded('u1', s)).toBe(false);
		writeFolded('u1', true, s);
		expect(readFolded('u1', s)).toBe(true);
		expect(readFolded('u2', s)).toBe(false);
		writeFolded('u1', false, s);
		expect(readFolded('u1', s)).toBe(false);
		expect(readFolded('u1', blocked())).toBe(false);
	});
});
