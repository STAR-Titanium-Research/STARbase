// The single mapping from a record to the page that shows it. Every link on our custom pages goes
// through here, so a page that is added later only needs one new line.
//
// Routes are app routes (the Directus app router is already rooted at /admin), so they work with
// router-link / router.push as they are. Anything without an Explorer page falls back to the
// Data Studio form at /content/<collection>/<id>.

const RECORD_PAGES: Record<string, string> = {
	physical_samples: '/home/samples',
	manufacturing_operations: '/home/operations',
	test_sessions: '/home/tests',
	campaigns: '/home/campaigns',
	projects: '/home/projects',
};

// Collections that have an Explorer index page (a list rather than one record).
const INDEX_PAGES: Record<string, string> = {
	projects: '/home/projects',
};

export function recordRoute(collection: string, id: string | number): string {
	const base = RECORD_PAGES[collection];
	const key = encodeURIComponent(String(id));
	return base ? `${base}/${key}` : `/content/${collection}/${key}`;
}

// The list page for a collection: the Explorer index if there is one, else the Data Studio list.
export function collectionRoute(collection: string): string {
	return INDEX_PAGES[collection] ?? `/content/${collection}`;
}

// Where "Open in Data Studio" goes: always the form, whatever the Explorer shows.
export function dataStudioRoute(collection: string, id: string | number): string {
	return `/content/${collection}/${encodeURIComponent(String(id))}`;
}
