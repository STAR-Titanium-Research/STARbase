import type { BrowserContext, Request } from '@playwright/test';
import { D1_BASE, STAR_BASE, pointAtD1 } from './target';

// A stand-in for d1-server for the specs that need no real data (spec 16): a signed-in admin, the
// collections the sidebar lists, empty item lists, and the /d1-usage nav, pin, pin-order and prefs
// endpoints, stateful in memory (core/extensions/d1-usage is what answers them for real: the same
// shapes, the default pins Samples then Projects given once, a 409 on a reorder that does not hold
// the current pins). Answers through Playwright routes, so STARbase runs from `vite preview` under
// its production CSP and the browser sees d1-server's origin.

export interface Pin {
	kind: 'page' | 'view' | 'record';
	target: string;
}

export interface StubState {
	pins: Pin[];
	prefs: Record<string, unknown>;
	// "METHOD /path" of every request STARbase made to d1-usage, in order.
	usage: string[];
	// While set, GET /d1-usage/nav is not answered until it settles (first paint before the preferences load).
	holdNav: Promise<void> | null;
	// GET /d1-usage/nav answers 500.
	failNav: boolean;
	// The page keys GET /d1-usage lists as used, best first. Like the real endpoint, the answer leaves out pinned pages.
	usedPages: string[];
	// POST /d1-usage/pin answers 500 (and changes nothing).
	failPin: boolean;
	// The saved views GET /presets lists (none by default, so the sidebar shows no views).
	bookmarks: StubBookmark[];
}

export interface StubBookmark {
	id: number;
	bookmark: string;
	collection: string;
}

// The one record the stand-in has: a sample. GET /items/physical_samples/<id> answers it, and so does the
// list read (by id) that gives a pinned record its code in the sidebar.
export const STUB_SAMPLE = {
	sample_id: '123e4567-e89b-42d3-a456-426614174000',
	sample_code: 'S-0042',
	nickname: 'Test coupon',
	current_status: 'available',
};

const COLLECTIONS = [
	'campaigns', 'cutting_inserts', 'equipment', 'etchants', 'facilities', 'fast_recipes', 'insert_edges', 'insert_types',
	'manufacturers', 'manufacturing_methods', 'manufacturing_operations', 'material_iso_classifications', 'materials', 'people',
	'physical_samples', 'prep_recipes', 'projects', 'raw_stock_lots', 'test_sessions', 'tool_boxes', 'tools',
];

export async function stubD1(context: BrowserContext): Promise<StubState> {
	const state: StubState = { pins: [{ kind: 'page', target: 'samples' }, { kind: 'page', target: 'projects' }], prefs: {}, usage: [], holdNav: null, failNav: false, usedPages: [], failPin: false, bookmarks: [] };
	await pointAtD1(context);
	const cors = {
		'access-control-allow-origin': STAR_BASE,
		'access-control-allow-credentials': 'true',
		'access-control-allow-headers': 'content-type, authorization',
		'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
		'access-control-expose-headers': 'content-disposition',
	};
	const same = (a: Pin, b: Pin) => a.kind === b.kind && a.target === b.target;

	await context.route(`${D1_BASE}/**`, async (route) => {
		const req: Request = route.request();
		const url = new URL(req.url());
		const path = url.pathname;
		const method = req.method();
		const json = (data: unknown, status = 200) => route.fulfill({ status, headers: cors, json: data });
		if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
		if (path.startsWith('/d1-usage')) state.usage.push(`${method} ${path}`);
		const body = () => (req.postDataJSON() ?? {}) as any;

		if (path === '/users/me') return json({ data: { id: 'u1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.org', role: 'r1' } });
		if (path === '/policies/me/globals') return json({ data: { admin_access: true } });
		if (path === '/collections') return json({ data: COLLECTIONS.map((collection) => ({ collection, meta: { hidden: false } })) });
		if (path === '/d1-usage/nav') {
			if (state.holdNav) await state.holdNav;
			if (state.failNav) return json({ error: 'down' }, 500);
		}
		if (path === '/d1-usage/nav') return json({ pins: state.pins, prefs: state.prefs });
		if (path === '/d1-usage' && method === 'GET') {
			const left = state.usedPages.filter((k) => !state.pins.some((p) => p.kind === 'page' && p.target === k));
			return json({ pages: left.map((target) => ({ target, pinned: false })), records: [] });
		}
		if (path === '/d1-usage/pin' && method === 'POST') {
			if (state.failPin) return json({ error: 'down' }, 500);
			const { kind, target, pinned } = body();
			const pin: Pin = { kind, target };
			state.pins = state.pins.filter((p) => !same(p, pin));
			if (pinned) state.pins.push(pin);
			return route.fulfill({ status: 204, headers: cors });
		}
		if (path === '/d1-usage/pin-order' && method === 'POST') {
			const items: Pin[] = body().items ?? [];
			const holdsPins = items.length === state.pins.length && state.pins.every((p) => items.some((i) => same(i, p)));
			if (!holdsPins) return json({ error: 'pins changed' }, 409);
			state.pins = items.map((i) => ({ kind: i.kind, target: i.target }));
			return route.fulfill({ status: 204, headers: cors });
		}
		if (path === '/d1-usage/prefs' && method === 'POST') {
			state.prefs = { ...state.prefs, ...body() };
			return route.fulfill({ status: 204, headers: cors });
		}
		if (path === '/d1-usage/pins/reset' && method === 'POST') {
			state.pins = [{ kind: 'page', target: 'samples' }, { kind: 'page', target: 'projects' }];
			return route.fulfill({ status: 204, headers: cors });
		}
		if (path === '/d1-usage/clear' && method === 'POST') return route.fulfill({ status: 204, headers: cors });
		if (path.startsWith('/d1-usage')) return json({ data: [] });
		if (path === '/presets' && method === 'GET') {
			return json({ data: state.bookmarks.map((b) => ({ ...b, user: null, role: null, filter: null, search: null, layout_query: null })) });
		}
		const sample = /^\/items\/physical_samples(?:\/([^/]+))?$/.exec(path);
		if (sample && method === 'GET') {
			if (sample[1]) return sample[1] === STUB_SAMPLE.sample_id ? json({ data: STUB_SAMPLE }) : json({ errors: [{ extensions: { code: 'FORBIDDEN' } }] }, 403);
			if ((url.searchParams.get('filter') ?? '').includes(STUB_SAMPLE.sample_id)) return json({ data: [STUB_SAMPLE] });
		}
		// Everything else a page reads: an empty answer.
		return json({ data: method === 'GET' && /\/(items|presets|fields)\b/.test(path) ? [] : {} });
	});
	return state;
}
