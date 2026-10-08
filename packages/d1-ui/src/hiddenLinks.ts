// Telling "no record is linked" from "a record is linked that you may not see".
//
// Row-level visibility (ADR-0011) filters the target of a many-to-one link: Directus then returns
// null for `fields=sample_id.sample_code` (not the bare id), the same as for an empty link. The
// raw foreign key on the row itself is still readable, so one extra read of the plain field names
// settles it: expanded value null + raw key set = hidden.

type Row = Record<string, unknown> | null | undefined;

// The fields whose expanded value came back empty: only these can be hidden links.
export function emptyLinks(row: Row, fields: string[]): string[] {
	return fields.filter((f) => row?.[f] === null || row?.[f] === undefined);
}

// field -> true when the raw row has a key there (a record is linked), for the given fields.
export function hiddenFrom(raw: Row, fields: string[]): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const f of fields) {
		const v = raw?.[f];
		if (v !== null && v !== undefined && v !== '') out[f] = true;
	}
	return out;
}

type GetItem = (collection: string, id: string, params?: Record<string, unknown>) => Promise<any>;

// Which of `fields` link to a record the user cannot read. `row` is the record as already read
// with expanded relations. No extra request when every link came back as a record; a failed read
// answers "none hidden" (the page then says what it did before, instead of breaking).
export async function readHiddenLinks(
	getItem: GetItem,
	collection: string,
	id: string,
	row: Row,
	fields: string[],
): Promise<Record<string, boolean>> {
	const empty = emptyLinks(row, fields);
	if (!empty.length) return {};
	try {
		return hiddenFrom(await getItem(collection, id, { fields: empty }), empty);
	} catch {
		return {};
	}
}
