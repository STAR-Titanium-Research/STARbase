// Directus hook: d1-edit-untracked
//
// Directus remembers each user's last page (directus_users.last_page, written by the app through
// PATCH /users/me/track/page on every route change) and sends them back there when they open /admin.
// The form-only page STARbase frames (d1-edit-frame, /admin/d1-edit/<collection>/<id>) has no module
// bar or navigation, so once it is remembered, opening Directus lands on a bare form with no way out.
// Directus itself skips only routes ending in /preview, for the same reason.
//
// This filter keeps a d1-edit path out of last_page: the user's previous last page stays, or
// /content when that was a d1-edit path too (which also clears anyone already stuck, on their next edit).

export const FALLBACK_PAGE = '/content';

export function isEditFramePage(page) {
	return typeof page === 'string' && /^\/d1-edit(\/|\?|$)/.test(page);
}

export default ({ filter }) => {
	filter('users.update', async (payload, meta, context) => {
		if (!payload || !isEditFramePage(payload.last_page)) return payload;
		let previous = null;
		const keys = meta?.keys ?? [];
		const db = context?.database;
		if (db && keys.length === 1) {
			try {
				const row = await db('directus_users').where({ id: keys[0] }).first('last_page');
				previous = row?.last_page ?? null;
			} catch {
				previous = null;
			}
		}
		return { ...payload, last_page: previous && !isEditFramePage(previous) ? previous : FALLBACK_PAGE };
	});
};
