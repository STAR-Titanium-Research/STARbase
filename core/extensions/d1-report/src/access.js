// Permission-aware reads for the d1-report endpoints.
//
// The report endpoints used to read with the root `database` knex handle and only
// checked that a user was logged in, so any account — whatever its collection
// permissions — could fetch full reports and probe which sample codes exist.
// Everything here goes through Directus's ItemsService with the *caller's*
// accountability, so the caller's own row, field and collection permissions apply.
//
// A forbidden read and a missing row look identical (FORBIDDEN is swallowed into
// null / []), so a caller cannot tell "not permitted" from "does not exist".

const isDenied = (err) => err?.code === 'FORBIDDEN' || err?.status === 403;

export function createAccess({ ItemsService, accountability, schema }) {
	const svc = (collection) => new ItemsService(collection, { accountability, schema });

	// One row by primary key, or null when it is missing OR the caller may not read it.
	// '*' = every field the caller is allowed to see (an explicit field list would be
	// refused outright if any listed field were restricted).
	async function one(collection, id) {
		if (id === null || id === undefined || id === '') return null;
		try {
			return (await svc(collection).readOne(id, { fields: ['*'] })) ?? null;
		} catch (err) {
			if (isDenied(err)) return null;
			throw err;
		}
	}

	// The first row matching a filter, or null (missing or not permitted).
	async function first(collection, filter, fields = ['*']) {
		try {
			const rows = await svc(collection).readByQuery({ filter, fields, limit: 1 });
			return rows?.[0] ?? null;
		} catch (err) {
			if (isDenied(err)) return null;
			throw err;
		}
	}

	// Every row matching a filter that the caller may read (at most `limit`; -1 = all);
	// [] when none or forbidden.
	async function list(collection, filter, fields = ['*'], sort, limit = -1) {
		try {
			return (
				(await svc(collection).readByQuery({
					filter,
					fields,
					limit,
					...(sort ? { sort } : {}),
				})) ?? []
			);
		} catch (err) {
			if (isDenied(err)) return [];
			throw err;
		}
	}

	// How many rows match a filter among those the caller may read; 0 when forbidden.
	async function count(collection, filter) {
		try {
			const rows = await svc(collection).readByQuery({ filter, aggregate: { count: ['*'] } });
			return Number(rows?.[0]?.count) || 0;
		} catch (err) {
			if (isDenied(err)) return 0;
			throw err;
		}
	}

	// Can the caller read this collection at all (any row)?
	async function canRead(collection) {
		try {
			await svc(collection).readByQuery({ fields: ['*'], limit: 1 });
			return true;
		} catch (err) {
			if (isDenied(err)) return false;
			throw err;
		}
	}

	// Which of `ids` (values of `pk`) can the caller read? Returns a Set of strings.
	async function readableIds(collection, pk, ids) {
		const wanted = [...new Set(ids.filter((v) => v !== null && v !== undefined).map(String))];
		if (!wanted.length) return new Set();
		const rows = await list(collection, { [pk]: { _in: wanted } }, [pk]);
		return new Set(rows.map((r) => String(r[pk])));
	}

	return { one, first, list, count, canRead, readableIds };
}
