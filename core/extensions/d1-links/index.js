// Directus endpoint: d1-links  (mounted at /d1-links)
//
//   GET /d1-links -> { starbaseUrl: string | null }
//
// Where STARbase answers, as d1-server's own setting (STARBASE_URL, the same one d1-report's QR codes
// and links use; spec §3.6). Two readers: the edit frame (d1-edit-frame) posts its messages only to this
// origin, and the Home module's quiet "Open in STARbase" link (Q12). null while it is unset, or when it is
// not an absolute http(s) address: the frame then tells nobody, and the link stays hidden. Signed-in
// users only. No build step (the d1-usage pattern): Directus loads this file as it is.

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

export function mount(router, env) {
	router.get('/', (req, res) => {
		if (!req.accountability?.user) return res.status(401).json({ errors: [{ message: 'Authentication required.' }] });
		res.set('Cache-Control', 'no-store');
		return res.json({ starbaseUrl: starbaseUrlFrom(env) });
	});
}

export default {
	id: 'd1-links',
	handler: (router, { env }) => mount(router, env),
};
