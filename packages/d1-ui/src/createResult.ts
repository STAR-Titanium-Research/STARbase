// Reading the answer to a create (POST /items/<collection>). Directus returns the new row only when
// the creator may read it; since ADR-0011 a user whose login is linked to no People row owns
// nothing, so a sample they just registered is not readable by them and the answer is empty
// (HTTP 204). That is a success the page must not report as an error.

export function createdRecord(body: unknown, idField: string, codeField: string): { id: string; code: string } | null {
	const row = (body as any)?.data;
	const id = row?.[idField];
	if (typeof id !== 'string' || !id) return null;
	return { id, code: typeof row?.[codeField] === 'string' ? row[codeField] : '' };
}

export const NO_PERSON_MESSAGE =
	'Your login is not linked to a person record, so you could not see (or own) a sample you register. Ask an admin to link it on the People page first.';

export const CREATED_BUT_HIDDEN_MESSAGE =
	"Created, but you can't see it. Ask an admin to link your login to a People row.";
