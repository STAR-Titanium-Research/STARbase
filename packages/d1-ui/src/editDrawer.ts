// Pure parts of EditDrawer: which fields the form shows, what is sent, and the OCC check.

// The bits of a Directus field definition we look at (from useFieldsStore()).
export interface FieldDef {
	field: string;
	type?: string;
	schema?: { is_primary_key?: boolean } | null;
	meta?: { system?: boolean; hidden?: boolean; readonly?: boolean; special?: string[] | null } | null;
}

// The form shows the fields the signed-in user can read, plus the presentation fields that have no
// column behind them (the buttons, the geometry preview, the file links, the composition bar):
// those exist only as interfaces and are never in the item. Directus returns only the fields the
// role may read, so a key missing from the item is one the user may not see; hiding it matches
// what the Data Studio form does. `hidden` names fields a page already shows itself and does not
// want twice (the Campaign page has the d1-campaign-ops panel in its body).
export function formFields(fields: FieldDef[], item: Record<string, unknown> | null, hidden: string[] = []): FieldDef[] {
	if (!item) return [];
	return fields.filter((f) => {
		if (f.meta?.system || hidden.includes(f.field)) return false;
		if (f.schema === null || f.schema === undefined) return true; // alias / presentation
		return f.field in item;
	});
}

// What is PATCHed: only the fields the form reports as changed. `edits` is the form's v-model,
// which holds changes only; undefined values are dropped, null (clearing a field) is kept.
// Nothing changed gives null, so the caller can skip the request.
export function buildPatch(edits: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(edits ?? {})) {
		if (value !== undefined) patch[key] = value;
	}
	return Object.keys(patch).length ? patch : null;
}

// Collections here carry an OCC `version` (occ_update_trigger_function() increments it on every
// update). If it moved since the record was loaded, someone else saved in between.
export function versionChanged(loaded: unknown, current: unknown): boolean {
	if (loaded === undefined || loaded === null || current === undefined || current === null) return false;
	return Number(loaded) !== Number(current);
}

// Messages from a failed PATCH: every Directus error, not just the first.
export function saveErrors(e: any): string[] {
	const list: any[] = e?.response?.data?.errors ?? [];
	const messages = list.map((x) => x?.message).filter(Boolean);
	return messages.length ? messages : [e?.message || 'The record could not be saved.'];
}
