// The state of the gear a record names (the machine, the tool, the cutting edge), for the warning on a template and on the card made from it
// ("the tool is retired", "the edge is used up"). Pure: which rows to read for a field and what a row says. useGearStatus.ts reads them.
// The status fields are the database's own: `equipment.is_active`, `tools.is_active` (false = retired) and `insert_edges.is_used` (true once
// a machining pass has consumed the edge; an insert is depleted when all its edges are).

/** The fields of a record that name gear whose state matters: the machine, the tool and the cutting edge. */
export const GEAR_FIELDS = ['equipment_id', 'tool_id', 'insert_edge_id'] as const;
export type GearField = (typeof GEAR_FIELDS)[number];

/** The gear a set of values names, by field. */
export function gearIn(values: Record<string, unknown>): { field: GearField; id: string }[] {
	return GEAR_FIELDS.flatMap((field) => (typeof values[field] === 'string' && values[field] ? [{ field, id: values[field] as string }] : []));
}

export interface GearRead {
	collection: string;
	key: string;
	fields: string[];
}

/** What to read for each field that names gear. */
export const GEAR_READS: Record<GearField, GearRead> = {
	equipment_id: { collection: 'equipment', key: 'equipment_id', fields: ['equipment_id', 'equipment_code', 'equipment_name', 'is_active'] },
	tool_id: { collection: 'tools', key: 'tool_id', fields: ['tool_id', 'tool_code', 'tool_name', 'is_active'] },
	insert_edge_id: { collection: 'insert_edges', key: 'edge_id', fields: ['edge_id', 'edge_code', 'is_used'] },
};

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** What a row says of its gear: the warning when it is retired or used up, else null (it is fine). */
export function gearProblem(field: GearField, row: Record<string, unknown>): string | null {
	if (field === 'equipment_id') {
		const name = text(row.equipment_name) || text(row.equipment_code) || 'machine';
		return row.is_active === false ? `The machine ${name} is retired.` : null;
	}
	if (field === 'tool_id') {
		const name = text(row.tool_name) || text(row.tool_code) || 'tool';
		return row.is_active === false ? `The tool ${name} is retired.` : null;
	}
	const code = text(row.edge_code);
	return row.is_used === true ? `The cutting edge${code ? ` ${code}` : ''} is used up.` : null;
}

export const gearKey = (field: GearField, id: string): string => `${field}:${id}`;

/** The ids to ask about, by field, leaving out those already known or being asked. */
export function gearToRead(want: readonly { field: GearField; id: string }[], known: (key: string) => boolean): Record<GearField, string[]> {
	const out = Object.fromEntries(GEAR_FIELDS.map((f) => [f, [] as string[]])) as Record<GearField, string[]>;
	for (const w of want) if (!known(gearKey(w.field, w.id)) && !out[w.field].includes(w.id)) out[w.field].push(w.id);
	return out;
}
