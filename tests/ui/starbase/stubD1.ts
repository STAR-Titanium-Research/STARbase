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
}

const COLLECTIONS = [
	'campaigns', 'cutting_inserts', 'equipment', 'etchants', 'facilities', 'fast_recipes', 'insert_edges', 'insert_types',
	'manufacturers', 'manufacturing_methods', 'manufacturing_operations', 'material_iso_classifications', 'materials', 'people',
	'physical_samples', 'prep_recipes', 'projects', 'raw_stock_lots', 'test_sessions', 'tool_boxes', 'tools',
];

export async function stubD1(context: BrowserContext): Promise<StubState> {
	const state: StubState = { pins: [{ kind: 'page', target: 'samples' }, { kind: 'page', target: 'projects' }], prefs: {}, usage: [] };
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
		if (path === '/d1-usage/nav') return json({ pins: state.pins, prefs: state.prefs });
		if (path === '/d1-usage/pin' && method === 'POST') {
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
		if (path.startsWith('/d1-usage')) return json({ data: [] });
		// Everything else a page reads: an empty answer.
		return json({ data: method === 'GET' && /\/(items|presets|fields)\b/.test(path) ? [] : {} });
	});
	return state;
}
