// The single mapping from a record to the page that shows it. Every link on our custom pages goes
// through here, so a page that is added later only needs one new line.
//
// Routes are app routes (the Directus app router is already rooted at /admin), so they work with
// router-link / router.push as they are. Anything without an Explorer page falls back to the
// Data Studio form at /content/<collection>/<id>.

import { INDEX_DEFS } from './index/indexConfig';

const RECORD_PAGES: Record<string, string> = {
	physical_samples: '/home/samples',
	manufacturing_operations: '/home/operations',
	test_sessions: '/home/tests',
	campaigns: '/home/campaigns',
	projects: '/home/projects',
	// One page renders all three, so moving inside a tool box never remounts it.
	tool_boxes: '/home/tool-boxes',
	cutting_inserts: '/home/inserts',
	insert_edges: '/home/edges',
};

// Collections that have an Explorer index page (a list rather than one record): the generic index
// pages from indexConfig, plus the two bespoke ones. indexConfig.ts is plain data with no imports,
// so this file stays safe to import on its own (the force app does, as @d1/ui/recordRoute).
const INDEX_PAGES: Record<string, string> = {
	...Object.fromEntries(INDEX_DEFS.map((d) => [d.collection, `/home/${d.slug}`])),
	projects: '/home/projects',
	people: '/home/people',
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

// A list page, optionally with a saved view (?bookmark=<id>), a row's drawer open (?open=<key>) or
// extra query keys of the index page's own URL: `query` is written as given, e.g. { q: 'A-12' } for
// a search or { 'f.project_id': id } for a chip filter. Projects and People are bespoke pages that
// ignore all of these, so they get the plain path; a collection with no Explorer page opens the
// Data Studio list, which understands only ?bookmark.
export function indexRoute(
	collection: string,
	opts: { bookmark?: number; open?: string; query?: Record<string, string> } = {},
): string {
	const base = INDEX_PAGES[collection];
	if (!base) return opts.bookmark !== undefined ? `/content/${collection}?bookmark=${opts.bookmark}` : `/content/${collection}`;
	if (collection === 'projects' || collection === 'people') return base;
	const params: string[] = [];
	if (opts.bookmark !== undefined) params.push(`bookmark=${opts.bookmark}`);
	if (opts.open !== undefined) params.push(`open=${encodeURIComponent(opts.open)}`);
	for (const [key, value] of Object.entries(opts.query ?? {})) {
		if (value !== '') params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
	}
	return params.length ? `${base}?${params.join('&')}` : base;
}
