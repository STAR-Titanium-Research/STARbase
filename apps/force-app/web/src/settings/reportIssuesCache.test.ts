import { beforeEach, describe, expect, it } from 'vitest';
import {
	PENDING_MAX_MS, STALE_MS, addOptimistic, applyFetched, cachedAt, cachedIssues, isStale, mergeIssues, optimisticRow, resetIssuesCache,
} from './reportIssuesCache';

const row = (number: number, state = 'open') => ({ number, title: `issue ${number}`, url: `https://x/${number}`, state });

beforeEach(resetIssuesCache);

describe('isStale', () => {
	it('is stale when never fetched or older than the window', () => {
		expect(isStale(1_000_000, 0)).toBe(true);
		expect(isStale(1_000_000 + STALE_MS - 1, 1_000_000)).toBe(false);
		expect(isStale(1_000_000 + STALE_MS + 1, 1_000_000)).toBe(true);
	});
});

describe('optimisticRow', () => {
	it('builds an open row from the create response', () => {
		expect(optimisticRow({ number: 7, url: 'https://x/7', title: '[Bug] t', labels: ['a', 3] })).toEqual({
			number: 7, title: '[Bug] t', url: 'https://x/7', state: 'open', labels: ['a'],
		});
	});
	it('refuses a response it cannot link to', () => {
		expect(optimisticRow({ url: 'https://x/7' })).toBeNull();
		expect(optimisticRow({ number: 7 })).toBeNull();
	});
	it('falls back to the typed title', () => {
		expect(optimisticRow({ number: 8, url: 'https://x/8' }, 'typed')?.title).toBe('typed');
	});
});

describe('mergeIssues', () => {
	it('keeps a row the list has not caught up with, newest first', () => {
		expect(mergeIssues([row(5), row(4)], [row(6)]).map((r) => r.number)).toEqual([6, 5, 4]);
	});
	it('prefers the fetched row for the same number', () => {
		const merged = mergeIssues([row(6, 'closed')], [row(6)]);
		expect(merged).toHaveLength(1);
		expect(merged[0].state).toBe('closed');
	});
});

describe('optimistic lifecycle (#88)', () => {
	it('survives a refetch that lags, and is retired once the list has it', () => {
		applyFetched([row(5)], 1000);
		addOptimistic(row(6), 2000);
		expect(cachedIssues.value.map((r) => r.number)).toEqual([6, 5]);
		applyFetched([row(5)], 5000); // GitHub hasn't listed #6 yet
		expect(cachedIssues.value.map((r) => r.number)).toEqual([6, 5]);
		applyFetched([row(6), row(5)], 9000); // now it has
		expect(cachedIssues.value.map((r) => r.number)).toEqual([6, 5]);
		applyFetched([row(5)], 10000); // retired: a later list without it no longer resurrects it
		expect(cachedIssues.value.map((r) => r.number)).toEqual([5]);
		expect(cachedAt.value).toBe(10000);
	});
	it('gives up on an unconfirmed row after a long time', () => {
		addOptimistic(row(9), 1000);
		applyFetched([row(5)], 1000 + PENDING_MAX_MS + 1);
		expect(cachedIssues.value.map((r) => r.number)).toEqual([5]);
	});
});
