// Directus endpoint: d1-links  (mounted at /d1-links)
//
//   GET /d1-links                              -> { starbaseUrl: string | null }
//   GET /d1-links/go                           -> 302 to STARbase Home
//   GET /d1-links/go/r/<collection>/<id>       -> 302 to the record's STARbase page, or its Data Studio form
//   GET /d1-links/go/p/<path>[?query]          -> 302 to a STARbase page, query kept as sent
//
// Where STARbase answers, as d1-server's own setting (STARBASE_URL, the same one d1-report's QR codes
// and links use; spec §3.6). One reader: the edit frame (d1-edit-frame) posts its messages only to this
// origin. null while it is unset, or when it is not an absolute http(s) address: the frame then tells
// nobody. Signed-in users only. No build step (the d1-usage pattern): Directus loads this file as it is.
//
// The three /go routes are the permanent links (spec §4): what a QR code, a label or a Force App link
// carries, so it keeps working when a page moves. They are public (a phone scanning a QR code has no
// session yet; STARbase asks it to sign in), read nothing from the database, and answer with
// Cache-Control: no-store. 302 on success, 400 on a bad path, 503 (plain text) while STARBASE_URL is unset
// or not http(s).

export function starbaseUrlFrom(env) {
	const raw = String(env?.STARBASE_URL ?? '').trim().replace(/\/+$/, '');
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return u.protocol === 'https:' || u.protocol === 'http:' ? raw : null;
	} catch {
		return null;
	}
}

// The STARbase record pages (the same map as packages/d1-ui/src/recordRoute.ts RECORD_PAGES; a test
// checks the two agree). Anything else has no STARbase page and opens its Data Studio form.
export const RECORD_PAGES = {
	physical_samples: 'samples',
	manufacturing_operations: 'operations',
	test_sessions: 'tests',
	campaigns: 'campaigns',
	projects: 'projects',
};

const COLLECTION = /^[a-z][a-z0-9_]*$/;
const UNSET = 'The STARbase address is not configured on this server (STARBASE_URL).';

// Where a permanent link goes. kind: 'home' | 'r' (parts = [collection, id]) | 'p' (parts = path
// segments, already decoded). rawQuery is '' or '?…' exactly as the caller sent it.
export function goTarget(env, kind, parts, rawQuery = '') {
	const star = starbaseUrlFrom(env);
	if (!star) return { status: 503, text: UNSET };
	if (kind === 'home') return { status: 302, location: `${star}/` };
	if (kind === 'r') {
		const [collection, id] = parts;
		if (!COLLECTION.test(String(collection ?? '')) || id === undefined || id === '') return { status: 400, text: 'Bad record link.' };
		const key = encodeURIComponent(String(id));
		const page = Object.hasOwn(RECORD_PAGES, collection) ? RECORD_PAGES[collection] : undefined;
		if (page) return { status: 302, location: `${star}/${page}/${key}` };
		const base = String(env?.PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
		return { status: 302, location: `${base}/admin/content/${collection}/${key}` };
	}
	// 'p': every segment must be a plain name: no empty segment (// or a trailing /), no . or .., no
	// backslash, no colon (a scheme). The result is checked to stay on STARbase's origin as well.
	if (parts.some((s) => s === null || s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes(':'))) {
		return { status: 400, text: 'Bad page link.' };
	}
	const location = `${star}/${parts.map(encodeURIComponent).join('/')}${rawQuery}`;
	if (new URL(location).origin !== new URL(star).origin) return { status: 400, text: 'Bad page link.' };
	return { status: 302, location };
}

function answer(res, t) {
	res.set('Cache-Control', 'no-store');
	if (t.status === 302) return res.redirect(302, t.location);
	return res.status(t.status).type('text/plain').send(t.text);
}

// The page path and query exactly as sent: the raw path is split into segments BEFORE decoding, so an
// encoded slash (%2F) stays inside its segment; a segment that does not decode becomes null (a 400).
function pageParts(req) {
	const u = String(req.originalUrl ?? '');
	const q = u.indexOf('?');
	const path = q < 0 ? u : u.slice(0, q);
	const at = path.indexOf('/go/p/');
	const raw = at < 0 ? '' : path.slice(at + '/go/p/'.length);
	const parts = raw.split('/').map((seg) => {
		try { return decodeURIComponent(seg); } catch { return null; }
	});
	return { parts, rawQuery: q < 0 ? '' : u.slice(q) };
}

export function mount(router, env) {
	router.get('/', (req, res) => {
		if (!req.accountability?.user) return res.status(401).json({ errors: [{ message: 'Authentication required.' }] });
		res.set('Cache-Control', 'no-store');
		return res.json({ starbaseUrl: starbaseUrlFrom(env) });
	});
	// Permanent links (spec §4): public, so a phone scanning a QR code reaches STARbase's sign-in.
	// They read nothing from the database.
	router.get('/go', (_req, res) => answer(res, goTarget(env, 'home', [])));
	router.get('/go/r/:collection/:id', (req, res) => answer(res, goTarget(env, 'r', [req.params.collection, req.params.id])));
	router.get(/^\/go\/p\/(.*)$/, (req, res) => {
		const { parts, rawQuery } = pageParts(req);
		return answer(res, goTarget(env, 'p', parts, rawQuery));
	});
}

export default {
	id: 'd1-links',
	handler: (router, { env }) => mount(router, env),
};
