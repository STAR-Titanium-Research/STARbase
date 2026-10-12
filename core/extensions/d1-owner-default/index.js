// Directus hook: d1-owner-default
//
// The owner of a sample, manufacturing operation, test session, campaign or other ownable
// collection, and the principal investigator of a project, should default to whoever creates
// the record, but stay editable ("login wins"). Directus has no native "default to current user
// but editable" for a normal field (the `user-created` special is auto + readonly), so this
// filter fills the field on create when the caller didn't supply one. Covers the force app, API
// scripts and bulk writes that don't go through the d1-owner-picker form interface.
//
// Ownership points at `people` (owner_person_id; principal_investigator_person on projects), not
// directus_users, so we resolve the creating user to their *researcher* person row and default
// that -- a login without a linked researcher person (machine tokens, technicians-only accounts)
// leaves the owner blank rather than failing the write or misattributing it.
//
// Since ADR-0011 the owner is also what lets the creator see and edit the record they just made:
// the Lab Member permission filters match `owner_person_id.user_id` (a project's
// `principal_investigator_person.user_id`) to the signed-in user, so a record created with no
// owner would be invisible to its creator, and a project with no PI could only be changed by an
// admin. Explicit choices always win.

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
		if (!field) return payload;
		const user = context?.accountability?.user;
		const db = context?.database;
		if (!user || !db || !payload) return payload;

		// Only set when the caller left it blank -- explicit choices win. Resolve the person once.
		const items = Array.isArray(payload) ? payload : [payload];
		const blank = items.filter((item) => item && typeof item === 'object' && isBlank(item[field]));
		if (blank.length === 0) return payload;
		const person = await db('people').where({ user_id: user, is_researcher: true }).first('person_id');
		if (person) for (const item of blank) item[field] = person.person_id;
		return payload;
	});
};
