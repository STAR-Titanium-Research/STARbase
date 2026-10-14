import { describe, expect, it } from 'vitest';
import {
	COUNT_CHUNK, chunkIds, edgeJunctionCountParams, edgeTestsFilter, junctionCountsByEdge, mergeEdgeCounts,
} from './edgeHistory';

describe('edgeTestsFilter', () => {
	it('matches the first-subject column and any insert_edges subject of the junction', () => {
		expect(edgeTestsFilter('e1')).toEqual({
			_or: [
				{ insert_edge_id: { _eq: 'e1' } },
				{ subject: { _some: { _and: [{ collection: { _eq: 'insert_edges' } }, { item: { _eq: 'e1' } }] } } },
			],
		});
	});
});

describe('chunkIds', () => {
	it('keeps a short list whole, and splits a long one without losing an id', () => {
		expect(chunkIds(['a', 'b'])).toEqual([['a', 'b']]);
		const ids = Array.from({ length: COUNT_CHUNK * 2 + 5 }, (_, i) => `e${i}`);
		const parts = chunkIds(ids);
		expect(parts.map((p) => p.length)).toEqual([COUNT_CHUNK, COUNT_CHUNK, 5]);
		expect(parts.flat()).toEqual(ids);
	});
	it('gives no chunk for no ids', () => {
		expect(chunkIds([])).toEqual([]);
	});
});

describe('edgeJunctionCountParams', () => {
	it('counts distinct tests per edge in the junction, for insert_edges subjects of the given ids', () => {
		expect(edgeJunctionCountParams(['e1', 'e2'])).toEqual({
			aggregate: { countDistinct: 'test_sessions_id' },
			groupBy: ['item'],
			filter: { _and: [{ collection: { _eq: 'insert_edges' } }, { item: { _in: ['e1', 'e2'] } }] },
			limit: -1,
		});
	});
});

describe('junctionCountsByEdge', () => {
	it('reads the nested countDistinct Directus returns, as numbers', () => {
		const m = junctionCountsByEdge([
			{ item: 'e1', countDistinct: { test_sessions_id: '3' } },
			{ item: 'e2', countDistinct: { test_sessions_id: 1 } },
			{ item: null, countDistinct: { test_sessions_id: '9' } },
			{ item: 'e3', countDistinct: { test_sessions_id: 'x' } },
		]);
		expect([...m]).toEqual([['e1', 3], ['e2', 1], ['e3', 0]]);
	});
	it('accepts a flat countDistinct too', () => {
		expect(junctionCountsByEdge([{ item: 'e1', countDistinct: '2' }]).get('e1')).toBe(2);
	});
});

describe('mergeEdgeCounts', () => {
	it('adds the maps key by key without changing the inputs', () => {
		const a = new Map([['e1', 2], ['e2', 1]]);
		const b = new Map([['e2', 4], ['e3', 1]]);
		const out = mergeEdgeCounts(a, b);
		expect([...out].sort()).toEqual([['e1', 2], ['e2', 5], ['e3', 1]]);
		expect(a.get('e2')).toBe(1);
	});
});
