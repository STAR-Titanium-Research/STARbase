// Run: node --experimental-strip-types --test core/extensions/d1-ask-db/test/*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	HISTORY_LIMIT,
	addQuestion,
	hasQuestion,
	HISTORY_KEY,
	SAVED_KEY,
	SAVED_LIMIT,
	loadList,
	mergeLists,
	dropLegacy,
	scopedKey,
	startsConversation,
	toggleSavedQuestion,
	SAVED_FULL_MESSAGE,
	updateList,
	parseStored,
	removeQuestion,
	saveList,
} from '../src/history.ts';

test('addQuestion: newest first, deduplicated ignoring case and spacing', () => {
	let l = addQuestion([], 'How many samples?', 1);
	l = addQuestion(l, 'Which tests?', 2);
	l = addQuestion(l, '  how   many SAMPLES? ', 3);
	assert.deepEqual(l, [
		{ question: 'how   many SAMPLES?', at: 3 },
		{ question: 'Which tests?', at: 2 },
	]);
});

test('addQuestion: blank is ignored; limit trims the oldest', () => {
	assert.deepEqual(addQuestion([], '   ', 1), []);
	let l: ReturnType<typeof addQuestion> = [];
	for (let i = 0; i < HISTORY_LIMIT + 5; i++) l = addQuestion(l, `q${i}`, i, HISTORY_LIMIT);
	assert.equal(l.length, HISTORY_LIMIT);
	assert.equal(l[0].question, `q${HISTORY_LIMIT + 4}`);
	assert.equal(l.at(-1)!.question, 'q5');
});

test('addQuestion without a limit never trims (saved list)', () => {
	let l: ReturnType<typeof addQuestion> = [];
	for (let i = 0; i < 50; i++) l = addQuestion(l, `q${i}`, i);
	assert.equal(l.length, 50);
});

test('removeQuestion / hasQuestion', () => {
	const l = addQuestion(addQuestion([], 'a', 1), 'b', 2);
	assert.equal(hasQuestion(l, ' A '), true);
	assert.deepEqual(removeQuestion(l, 'A').map((e) => e.question), ['b']);
});

test('parseStored drops malformed data instead of throwing', () => {
	assert.deepEqual(parseStored(null), []);
	assert.deepEqual(parseStored('{not json'), []);
	assert.deepEqual(parseStored('{"a":1}'), []);
	assert.deepEqual(parseStored('[null, 3, {"question":""}, {"question":"ok","at":"x"}, {"question":"fine","at":5}]'), [
		{ question: 'ok', at: 0 },
		{ question: 'fine', at: 5 },
	]);
});

test('loadList / saveList survive a localStorage that throws', () => {
	const g = globalThis as any;
	g.window = {
		localStorage: {
			getItem() {
				throw new Error('denied');
			},
			setItem() {
				throw new Error('denied');
			},
		},
	};
	assert.deepEqual(loadList('k'), []);
	assert.doesNotThrow(() => saveList('k', [{ question: 'q', at: 1 }]));
	const store = new Map<string, string>();
	g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } };
	saveList('k', [{ question: 'q', at: 1 }]);
	assert.deepEqual(loadList('k'), [{ question: 'q', at: 1 }]);
	delete g.window;
});

function fakeStorage() {
	const store = new Map<string, string>();
	(globalThis as any).window = {
		localStorage: {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		},
	};
	return store;
}

test('scopedKey: per user, bare key only without a user id', () => {
	assert.equal(scopedKey(HISTORY_KEY, 'u1'), 'd1-ask-db:history:u1');
	assert.equal(scopedKey(SAVED_KEY, 'u1'), 'd1-ask-db:saved:u1');
	assert.equal(scopedKey(HISTORY_KEY, null), 'd1-ask-db:history');
	assert.equal(scopedKey(HISTORY_KEY, ''), 'd1-ask-db:history');
});

test('two users on one browser keep separate lists', () => {
	fakeStorage();
	updateList(scopedKey(HISTORY_KEY, 'u1'), [], (l) => addQuestion(l, 'mine', 1, HISTORY_LIMIT));
	assert.deepEqual(loadList(scopedKey(HISTORY_KEY, 'u2')), []);
	assert.equal(loadList(scopedKey(HISTORY_KEY, 'u1'))[0].question, 'mine');
	delete (globalThis as any).window;
});

test('updateList re-reads storage so a second tab does not overwrite the first', () => {
	fakeStorage();
	const key = scopedKey(HISTORY_KEY, 'u1');
	let tabA: ReturnType<typeof loadList> = [];
	let tabB: ReturnType<typeof loadList> = [];
	tabA = updateList(key, tabA, (l) => addQuestion(l, 'from A', 1, HISTORY_LIMIT));
	// tab B still holds its stale (empty) in-memory list
	tabB = updateList(key, tabB, (l) => addQuestion(l, 'from B', 2, HISTORY_LIMIT));
	assert.deepEqual(tabB.map((e) => e.question), ['from B', 'from A']);
	assert.deepEqual(loadList(key).map((e) => e.question), ['from B', 'from A']);
	// removal in one tab is applied to the fresh list too
	updateList(key, tabA, (l) => removeQuestion(l, 'from A'));
	assert.deepEqual(loadList(key).map((e) => e.question), ['from B']);
	delete (globalThis as any).window;
});

test('updateList falls back to the in-memory list when storage throws', () => {
	(globalThis as any).window = {
		localStorage: {
			getItem() {
				throw new Error('denied');
			},
			setItem() {
				throw new Error('denied');
			},
		},
	};
	const next = updateList('k', [{ question: 'a', at: 1 }], (l) => addQuestion(l, 'b', 2));
	assert.deepEqual(next.map((e) => e.question), ['b', 'a']);
	delete (globalThis as any).window;
});

test('mergeLists: dedupes, newest first, capped', () => {
	const m = mergeLists([{ question: 'a', at: 1 }, { question: 'b', at: 5 }], [{ question: ' A ', at: 9 }, { question: 'c', at: 3 }], 3);
	assert.deepEqual(m.map((e) => e.question), [' A ', 'b', 'c']);
	assert.equal(SAVED_LIMIT, 100);
});

test('dropLegacy: deletes the bare (pre per-user) lists without giving them to anyone', () => {
	const store = fakeStorage();
	store.set(HISTORY_KEY, JSON.stringify([{ question: 'old', at: 1 }]));
	store.set(SAVED_KEY, JSON.stringify([{ question: 'pinned', at: 1 }]));
	store.set(scopedKey(HISTORY_KEY, 'u1'), JSON.stringify([{ question: 'new', at: 2 }]));
	dropLegacy(null); // no user id yet: nothing happens
	assert.ok(store.has(HISTORY_KEY));
	dropLegacy('u1');
	assert.equal(store.has(HISTORY_KEY), false);
	assert.equal(store.has(SAVED_KEY), false);
	assert.deepEqual(loadList(scopedKey(HISTORY_KEY, 'u1')).map((e) => e.question), ['new']);
	assert.deepEqual(loadList(scopedKey(SAVED_KEY, 'u1')), []);
	delete (globalThis as any).window;
});

test('startsConversation: only the first question of a conversation is remembered', () => {
	assert.equal(startsConversation(0), true);
	assert.equal(startsConversation(1), false);
	assert.equal(startsConversation(5), false);
});

test('startsConversation takes the context sent: a retry after a first-question error still starts one', () => {
	// An errored first turn contributes no context messages, so the rephrased retry sends none.
	assert.equal(startsConversation(0), true);
	// After a completed question (user + sql) a follow-up carries context and is not recorded.
	assert.equal(startsConversation(2), false);
});

test('toggleSavedQuestion: pins, unpins, and refuses a new pin when full instead of dropping the oldest', () => {
	let l: ReturnType<typeof loadList> = [];
	for (let i = 0; i < SAVED_LIMIT; i++) {
		const r = toggleSavedQuestion(l, `q${i}`, i);
		assert.equal(r.result, 'saved');
		l = r.list;
	}
	assert.equal(l.length, SAVED_LIMIT);
	const full = toggleSavedQuestion(l, 'one more', 999);
	assert.equal(full.result, 'full');
	assert.equal(full.list, l); // untouched: the oldest pin (q0) is still there
	assert.equal(hasQuestion(full.list, 'q0'), true);
	assert.match(SAVED_FULL_MESSAGE, /^Saved list is full \(100\) \u2014 remove one first$/);
	// unpinning works at the limit, and frees room for the new pin
	const removed = toggleSavedQuestion(l, ' Q0 ', 1000);
	assert.equal(removed.result, 'removed');
	assert.equal(toggleSavedQuestion(removed.list, 'one more', 1001).result, 'saved');
});
