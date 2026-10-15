// Directus hook: d1-person-link
//
// One login = one person. When a login is created, link the single unlinked
// people row with the same email (else the same full name); if there is no
// unique match, create a new person. Linked people are researchers (they can
// own records). Ambiguous matches never link, so two same-named technicians
// can't be silently attached to the wrong login.

async function uniqueUnlinked(db, column, value) {
	const rows = await db('people').whereNull('user_id').whereRaw(`lower(${column}) = ?`, [value]).limit(2).select('person_id');
	return rows.length === 1 ? rows[0].person_id : null;
}

// Postgres: foreign_key_violation, unique_violation
const LINKED_ELSEWHERE = new Set(['23503', '23505']);

export default ({ action }) => {
	action('users.create', async ({ key, payload }, { database }) => {
		if (!key || !database) return;
		try {
			await link(key, payload, database);
		} catch (err) {
			// The login was linked elsewhere (d1-people-admin's invite makes the login and links its person in one transaction, and this
			// event, on its own connection, runs before that commits: the foreign key to the not-yet-visible login fails), or the
			// transaction rolled back and the login never existed. Either way there is nothing for this hook to do.
			if (LINKED_ELSEWHERE.has(err?.code)) return;
			throw err;
		}
	});
};

async function link(key, payload, database) {
	if (await database('people').where('user_id', key).first('person_id')) return;
	const email = String(payload?.email ?? '').trim().toLowerCase();
	const name = `${payload?.first_name ?? ''} ${payload?.last_name ?? ''}`.trim();
	const match = (email && await uniqueUnlinked(database, 'email', email))
		|| (name && await uniqueUnlinked(database, 'full_name', name.toLowerCase()));
	if (match) {
		await database('people').where('person_id', match).update({
			user_id: key,
			is_researcher: true,
			email: database.raw('COALESCE(email, ?)', [email || null]),
		});
	} else {
		await database('people').insert({ full_name: name || email || 'Unnamed user', email: email || null, user_id: key, is_researcher: true });
	}
}
