// Which tests and operations an insert edge has, read through `/items`.
//
// A test names its subjects in the M2A junction `test_sessions_subject` (collection + item). Since
// migration 139 the column `test_sessions.insert_edge_id` holds only the FIRST insert_edges subject, so a
// test whose subjects are two edges of one insert would be missing from the second edge's history if
// only the column were read. The Sample page does the same for samples (useSampleData). These builders
// are pure; the reads, and the fallback for a role that may not read the junction, live in useToolingData.

const EDGES = 'insert_edges';

/** Ids per `_in` filter: the ids go into the query string, so a box with many edges is read in parts. */
export const COUNT_CHUNK = 300;

export function chunkIds(ids: readonly string[], size = COUNT_CHUNK): string[][] {
	const out: string[][] = [];
	for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
	return out;
}

/** The tests of one edge: its first-subject column, or any insert_edges subject of the junction. */
export function edgeTestsFilter(edgeId: string): Record<string, unknown> {
	return {
		_or: [
			{ insert_edge_id: { _eq: edgeId } },
			// The M2A item:<collection> path: a _some body keeps only its first key (Directus 11.17).
			{ subject: { _some: { [`item:${EDGES}`]: { edge_id: { _eq: edgeId } } } } },
		],
	};
}

/** `/items/test_sessions_subject` params: distinct tests per edge, for insert_edges subjects among `edgeIds`. */
export function edgeJunctionCountParams(edgeIds: readonly string[]): Record<string, unknown> {
	return {
		aggregate: { countDistinct: 'test_sessions_id' },
		groupBy: ['item'],
		filter: { _and: [{ collection: { _eq: EDGES } }, { item: { _in: [...edgeIds] } }] },
		limit: -1,
	};
}

/** The grouped junction rows as edge id -> tests. Directus nests the count by field (`countDistinct.test_sessions_id`) and returns bigints as strings. */
export function junctionCountsByEdge(rows: ReadonlyArray<Record<string, unknown>>): Map<string, number> {
	const out = new Map<string, number>();
	for (const r of rows) {
		const key = r.item;
		if (key === null || key === undefined || key === '') continue;
		const raw = r.countDistinct;
		const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).test_sessions_id : raw;
		const n = Number(value);
		out.set(String(key), Number.isFinite(n) ? n : 0);
	}
	return out;
}

/** Adds count maps key by key (tests plus operations per edge). */
export function mergeEdgeCounts(...maps: ReadonlyMap<string, number>[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const m of maps) for (const [k, n] of m) out.set(k, (out.get(k) ?? 0) + n);
	return out;
}
