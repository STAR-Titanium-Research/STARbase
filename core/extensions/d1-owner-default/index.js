// Directus hook: d1-owner-default
//
// "Login wins": a new record's owner defaults to the logged-in user's person
// when the caller leaves it blank (omitted, null or ''). Covers the force app,
// API scripts and bulk writes that don't go through the d1-owner-picker form
// interface. Logins without a linked *researcher* person (machine tokens) leave
// the owner blank rather than failing the write. Explicit choices always win.

export const OWNER_FIELDS = {
	physical_samples: 'owner_person_id',
	tool_boxes: 'owner_person_id',
	cutting_inserts: 'owner_person_id',
	insert_edges: 'owner_person_id',
	etchants: 'owner_person_id',
	prep_recipes: 'owner_person_id',
	campaigns: 'owner_person_id',
	manufacturing_operations: 'owner_person_id',
	test_sessions: 'owner_person_id',
	projects: 'principal_investigator_person',
};

const isBlank = (v) => v === undefined || v === null || v === '';

export default ({ filter }) => {
	filter('items.create', async (payload, meta, context) => {
		const field = OWNER_FIELDS[meta?.collection];
		if (!field || !payload || !isBlank(payload[field])) return payload;
		const user = context?.accountability?.user;
		const db = context?.database;
		if (!user || !db) return payload;
		const person = await db('people').where({ user_id: user, is_researcher: true }).first('person_id');
		if (person) payload[field] = person.person_id;
		return payload;
	});
};
