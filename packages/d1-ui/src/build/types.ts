// Types of the process map's edit mode (spec 2026-10-14-process-map-edit-mode-design.md §5.1 and §6): the draft body
// that STARbase keeps for its owner and that `d1-build` validates, and the answers of the `d1-build` routes. No Vue.

/** 'n1', 'n2', … unique within the draft. */
export type DraftKey = string;

export interface DraftBody {
	v: 1;
	projectId: string | null;
	campaignId: string | null;
	items: DraftItem[];
	wires: DraftWire[];
	positions: Record<DraftKey, { x: number; y: number }>;
	/** The highest key number handed out so far, so a removed key is never handed out again. Optional: older drafts have none. */
	seq?: number;
}

export type DraftItem = DraftSample | DraftOperation | DraftTest;

export interface DraftBase {
	key: DraftKey;
	/** A record that already exists. */
	existing?: { id: string; version: number };
	/** New record: all fields; existing: only the changed fields. */
	values: Record<string, unknown>;
	/** E18: delete this planned record at Create. */
	remove?: true;
}

export interface DraftSample extends DraftBase {
	kind: 'sample';
}

export interface DraftOperation extends DraftBase {
	kind: 'operation';
	workState: 'planned' | 'done';
	/** An existing record being given an input (E8 attach). */
	attach?: true;
	/** One per output piece (E9); in place = one row. */
	rows: { key: DraftKey }[];
}

export interface DraftTest extends DraftBase {
	kind: 'test';
	workState: 'planned' | 'done';
}

export interface DraftWire {
	/** A sample's output, or an operation row's output. */
	from: { key: DraftKey; row?: number };
	/** An operation row's input, a test, or a sample. */
	to: { key: DraftKey; row?: number };
}

/** One entry of Checks (E5, E13). `key` is the draft item it belongs to; `field` the field to fix, when there is one. */
export interface Check {
	/**
	 * Why the server says it (d1-build): GONE, NOT_ATTACHABLE, STALE_VERSION, REMOVE_BLOCKED, PERMISSION are what only a re-read
	 * of the records can tell; REQUIRED, STRUCTURE and OTHER the client's own checks already cover. Optional on checks the client makes.
	 */
	code?: string;
	key: DraftKey;
	field?: string;
	level: 'block' | 'warn';
	text: string;
}

// ---- d1-build responses (plan, "Shared contract") ----

export interface DraftListEntry {
	id: string;
	name: string;
	updated_at: string;
	summary: string;
}

export interface DraftRecord {
	id: string;
	name: string;
	body: DraftBody;
	version: number;
	updated_at: string;
}

export interface CheckResponse {
	data: { checks: Check[] };
}

export interface CreatedRecord {
	collection: string;
	id: string;
	code: string | null;
}

export interface CreateResponse {
	data: { created: Record<DraftKey, CreatedRecord>; sampleIds: string[] };
}

/** The 409 of Create: the checks that stop it. */
export interface CreateRefusal {
	errors: { message: string; extensions: { code: 'CHECKS'; checks: Check[] } }[];
}

/** The error of Create when one record's write failed (the draft key names the card). */
export interface WriteFailure {
	errors: { message: string; extensions: { code: 'WRITE_FAILED'; key: DraftKey } }[];
}

/** Mark a whole container done in one transaction: every operation row of it, or every pass of a stack. */
export interface MarkDoneBody {
	collection: 'manufacturing_operations' | 'test_sessions';
	ids: string[];
	/** YYYY-MM-DD; today when omitted. */
	date?: string;
	personId?: string;
}

export interface MarkDoneResponse {
	data: { ids: string[]; work_state: 'done' };
}

/** Back to planned (owner only): the same records as Mark done took. */
export interface MarkPlannedBody {
	collection: 'manufacturing_operations' | 'test_sessions';
	ids: string[];
}

export interface MarkPlannedResponse {
	data: { ids: string[]; work_state: 'planned' };
}

export interface TemplateRecord {
	id: string;
	name: string;
	scope: 'private' | 'role' | 'global';
	role_id: string | null;
	collection: 'manufacturing_operations' | 'test_sessions';
	values: Record<string, unknown>;
	user_id: string;
	updated_at: string;
	version: number;
}
