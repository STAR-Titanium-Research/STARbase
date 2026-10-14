// Links into the Process map (STARbase `/map`, spec section 8). The focus is `<collection>:<id>`; the id is
// encoded so a code with a space or a slash cannot break the query.

/** The kinds with no record page of their own (they open the Data Studio form): their index rows get a Process map action. */
export const MAP_ROW_COLLECTIONS: readonly string[] = [
	'tools',
	'equipment',
	'insert_edges',
	'raw_stock_lots',
	'materials',
	'prep_recipes',
	'fast_recipes',
];

export const mapPath = (collection: string, id: string): string => `/map?focus=${collection}:${encodeURIComponent(id)}`;
