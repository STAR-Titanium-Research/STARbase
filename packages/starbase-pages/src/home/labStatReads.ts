// The counts behind Home's "At a glance" tiles: which collection each reads, and with which filter. Machining, FAST (sintering) and
// Conform are one collection split by `process_category`. A Conform run is not machining, and the six-tile band has no room for a
// seventh tile, so Conform runs are left out of the split (they are in no tile) rather than inflating "Machining".

export interface StatRead {
	key: string;
	collection: string;
	filter?: unknown;
}

export const STAT_READS: readonly StatRead[] = [
	{ key: 'samples', collection: 'physical_samples' },
	{ key: 'machining', collection: 'manufacturing_operations', filter: { process_category: { _nin: ['sintering', 'conform'] } } },
	{ key: 'fast', collection: 'manufacturing_operations', filter: { process_category: { _eq: 'sintering' } } },
	{ key: 'tests', collection: 'test_sessions' },
	{ key: 'projects', collection: 'projects' },
	{ key: 'campaigns', collection: 'campaigns' },
];
