// What a test targets, read from the M2A junction test_sessions_subject (collection + item).
//
// One request with the M2A field syntax returns each target's own fields, so the Test page needs
// no second read of the samples:
//   fields: TEST_SUBJECT_FIELDS  ->  { collection: 'physical_samples', item: { sample_id, sample_code ... } }
// When the signed-in user may not read the target's collection, Directus gives the bare id in
// `item` instead of an object; the subject is still listed, as a link without a label. A target
// that row-level visibility hides comes back as null and is only counted (`hidden`).
// A junction row whose target was deleted (test_sessions_subject.item has no foreign key) also comes
// back as null and is counted as hidden too: telling the two apart would need a read of the target,
// and Directus answers 403 for a missing row and a filtered one alike, so it cannot be told apart
// for a non-admin; the raw key (a UUID of a sample that no longer exists) does not reveal it either.

import { asRecord } from './format';

export const TEST_SUBJECT_FIELDS = [
	'collection',
	'item:physical_samples.sample_id',
	'item:physical_samples.sample_code',
	'item:physical_samples.nickname',
	'item:physical_samples.form',
	'item:physical_samples.current_status',
	'item:insert_edges.edge_id',
	'item:insert_edges.edge_code',
];

export interface TestSubjects {
	samples: Record<string, any>[];
	/** Subjects that are not samples (an insert edge ...): collection, id and a label when readable. */
	others: { collection: string; item: string; label?: string }[];
	/**
	 * Junction rows whose target came back null: a record the user may not read (row-level
	 * visibility hides it the way it hides a many-to-one target), counted so the page can say so.
	 */
	hidden: number;
}

// How to find the id and the printed code of a subject that is not a sample, by collection.
const OTHER_KEYS: Record<string, { id: string; label: string }> = {
	insert_edges: { id: 'edge_id', label: 'edge_code' },
};

export function splitSubjects(rows: unknown[] | null | undefined): TestSubjects {
	const out: TestSubjects = { samples: [], others: [], hidden: 0 };
	for (const row of rows ?? []) {
		const r = asRecord(row);
		if (!r || typeof r.collection !== 'string') continue;
		const target = asRecord(r.item);
		if (r.item === null) {
			out.hidden++;
			continue;
		}
		if (r.collection === 'physical_samples') {
			const id = target?.sample_id ?? (typeof r.item === 'string' ? r.item : null);
			if (id) out.samples.push({ ...target, sample_id: String(id) });
			continue;
		}
		const keys = OTHER_KEYS[r.collection];
		const id = (keys && target?.[keys.id]) ?? (typeof r.item === 'string' || typeof r.item === 'number' ? r.item : null);
		if (id === null || id === undefined || id === '') continue;
		const label = keys ? target?.[keys.label] : undefined;
		out.others.push({ collection: r.collection, item: String(id), ...(typeof label === 'string' && label ? { label } : {}) });
	}
	return out;
}
