// The draft reducer of the process map's edit mode (spec §5.2): `apply(body, action) → body`. Pure, no Vue: every
// action returns a new body and leaves the old one untouched, so history.ts can keep bodies as they are. An action
// that cannot be done (a wire that does not fit, a key that is not in the draft) returns the same body, which
// history.ts reads as "nothing changed".
//
// Shape of a draft, in the words of the glossary: *items* (samples, operations, tests) joined by *wires*. A wire runs
// from a sample, or from one row of an operation, to an operation row's input, a test or a sample. Rows of an
// operation are its output pieces (E9): each row becomes one record, and rows of one operation share their settings.
//
// In place. An operation whose rows make no new sample leaves its sample where it is ("the sample continues"): no
// output wire, a wire back to the sample it took in, or a wire on to the next operation or test. The order of in-place
// passes on one sample is the order of `items` (a copy goes right after its original), so a pass appended to a stack
// of passes joins it once buildGraph draws it (groupBatches step 3).

import type { DraftBody, DraftItem, DraftKey, DraftOperation, DraftSample, DraftTest, DraftWire } from '@d1/ui';

export type Pos = { x: number; y: number };
/** One end of a wire. `row` is the row of an operation (default 0); samples and tests have none. */
export type WireEnd = { key: DraftKey; row?: number };
export type WorkState = 'planned' | 'done';

/** A new operation or test starts planned: laying out work is the common case, and planned records need only their structure (E5). */
export const DEFAULT_WORK_STATE: WorkState = 'planned';

/** Gap between cards of a column the draft places itself (a picked column of samples, a copy next to its original). */
export const COLUMN_GAP = 140;
export const COPY_OFFSET = 48;

export type ContainerSource =
	/** A blank operation of one method, or a blank test of one test type. */
	| { from: 'blank'; methodId?: string; testType?: string }
	/** A template's saved fields. */
	| { from: 'template'; values: Record<string, unknown> }
	/** An existing operation or test, copied (date, sample, notes and code left out). */
	| { from: 'newFrom'; values: Record<string, unknown> };

export type DraftAction =
	| { type: 'addSample'; values?: Record<string, unknown>; at?: Pos; from?: WireEnd }
	| { type: 'addExistingSamples'; samples: { id: string; version: number; values?: Record<string, unknown> }[]; at?: Pos }
	| { type: 'addContainer'; kind: 'operation' | 'test'; source: ContainerSource; workState?: WorkState; rows?: number; at?: Pos; from?: WireEnd }
	| { type: 'attach'; operation: { id: string; version: number }; workState: WorkState; values?: Record<string, unknown>; at?: Pos; from?: WireEnd }
	| { type: 'addOutputRow'; key: DraftKey }
	| {
			type: 'addPass';
			/** The sample the pass is done on: one already in the draft, or an existing one (added to the draft). */
			sample: { key: DraftKey } | { id: string; version: number };
			/** The settings of the pass it follows; left out when `after` is a draft pass (its own are used). */
			values?: Record<string, unknown>;
			workState?: WorkState;
			/** The draft pass this one goes after (default: at the end). */
			after?: DraftKey;
			at?: Pos;
	  }
	| { type: 'wire'; from: WireEnd; to: WireEnd }
	| { type: 'unwire'; from: WireEnd; to: WireEnd }
	| { type: 'setValues'; key: DraftKey; values: Record<string, unknown> }
	| { type: 'setWorkState'; key: DraftKey; workState: WorkState }
	| { type: 'duplicate'; key: DraftKey; n?: number; record?: Record<string, unknown> }
	| { type: 'remove'; key: DraftKey; deleteRecord?: boolean }
	| { type: 'move'; key: DraftKey; x: number; y: number }
	| { type: 'setProject'; projectId: string | null }
	| { type: 'setCampaign'; campaignId: string | null };

export function emptyBody(projectId: string | null = null, campaignId: string | null = null): DraftBody {
	return { v: 1, projectId, campaignId, items: [], wires: [], positions: {} };
}

// ---- reading a body ---------------------------------------------------------------------------

export const itemOf = (body: DraftBody, key: DraftKey): DraftItem | undefined => body.items.find((i) => i.key === key);

/** Every key the draft uses: items, operation rows, positions and wire ends. */
function usedKeys(body: DraftBody): Set<string> {
	const keys = new Set<string>(Object.keys(body.positions));
	for (const item of body.items) {
		keys.add(item.key);
		if (item.kind === 'operation') for (const r of item.rows) keys.add(r.key);
	}
	for (const w of body.wires) {
		keys.add(w.from.key);
		keys.add(w.to.key);
	}
	return keys;
}

/**
 * The key the next new item (or row) gets: 'n' and a counter above every key in the body and above `body.seq`, the highest
 * number ever handed out, so a key that was removed is never handed out again.
 */
export function nextKey(body: DraftBody, skip = 0): DraftKey {
	let max = body.seq ?? 0;
	for (const k of usedKeys(body)) {
		const m = /^n(\d+)$/.exec(k);
		if (m) max = Math.max(max, Number(m[1]));
	}
	return `n${max + 1 + skip}`;
}

/** The keys of items that `after` has and `before` has not, in the order of `after.items`. */
export const newKeys = (before: DraftBody, after: DraftBody): DraftKey[] => {
	const had = new Set(before.items.map((i) => i.key));
	return after.items.filter((i) => !had.has(i.key)).map((i) => i.key);
};

const sameEnd = (a: WireEnd, b: WireEnd) => a.key === b.key && (a.row ?? 0) === (b.row ?? 0);
const sameWire = (a: DraftWire, b: DraftWire) => sameEnd(a.from, b.from) && sameEnd(a.to, b.to);

/** The wire into an operation row (an operation row has at most one input). */
export function wireInto(body: DraftBody, key: DraftKey, row = 0): DraftWire | undefined {
	return body.wires.find((w) => w.to.key === key && (w.to.row ?? 0) === row);
}

/** The wires out of a sample, or out of one row of an operation. */
export function wiresOutOf(body: DraftBody, key: DraftKey, row?: number): DraftWire[] {
	return body.wires.filter((w) => w.from.key === key && (row === undefined || (w.from.row ?? 0) === row));
}

/**
 * The sample that feeds an operation row, a test's subject wire or an in-place continuation: follows operation → operation
 * wires back to the sample they started from. Null when nothing is wired yet.
 */
export function inputSampleOf(body: DraftBody, end: WireEnd, seen: Set<string> = new Set()): DraftKey | null {
	const id = `${end.key}:${end.row ?? 0}`;
	if (seen.has(id)) return null;
	seen.add(id);
	const item = itemOf(body, end.key);
	if (!item) return null;
	if (item.kind === 'sample') return item.key;
	const w = wireInto(body, end.key, item.kind === 'operation' ? (end.row ?? 0) : 0);
	if (!w) return null;
	return sourceSample(body, w, seen);
}

/** The sample a wire carries: a sample's own, or what the operation row it leaves carries on. */
function sourceSample(body: DraftBody, w: DraftWire, seen: Set<string>): DraftKey | null {
	const from = itemOf(body, w.from.key);
	if (!from) return null;
	return from.kind === 'sample' ? from.key : continuesAs(body, { key: w.from.key, row: w.from.row ?? 0 }, seen);
}

/**
 * The sample an operation row carries on to the next step: the one it makes, else the one it took in (in place). The same
 * rule as d1-build's `continuesAs`: a row that makes X and is wired on to a next operation or test carries X, not its input.
 */
export function continuesAs(body: DraftBody, end: WireEnd, seen: Set<string> = new Set()): DraftKey | null {
	const input = inputSampleOf(body, end, seen);
	return madeBy(body, end.key, end.row ?? 0, input) ?? input;
}

/** The samples a test is done on: its subject wires, each through the operation row it leaves. */
export function subjectsOf(body: DraftBody, testKey: DraftKey): DraftKey[] {
	const out: DraftKey[] = [];
	for (const w of body.wires) {
		if (w.to.key !== testKey) continue;
		const s = sourceSample(body, w, new Set());
		if (s && !out.includes(s)) out.push(s);
	}
	return out;
}

/** The target of an output wire of this row that is a sample other than `input` (null = in place or open). */
function madeBy(body: DraftBody, key: DraftKey, row: number, input: DraftKey | null): DraftKey | null {
	for (const w of wiresOutOf(body, key, row)) {
		const to = itemOf(body, w.to.key);
		if (to?.kind === 'sample' && to.key !== input) return to.key;
	}
	return null;
}

/** The sample an operation row makes: the target of its output wire when that is not the sample it took in (null = in place or open). */
export function outputSampleOf(body: DraftBody, key: DraftKey, row = 0): DraftKey | null {
	return madeBy(body, key, row, inputSampleOf(body, { key, row }));
}

/** An operation that makes no new sample on any row: its sample continues (a pass of a turning, a polish, a heat treatment). */
export function isInPlace(body: DraftBody, item: DraftOperation): boolean {
	return item.rows.length === 1 && outputSampleOf(body, item.key, 0) === null;
}

// ---- wiring rules -------------------------------------------------------------------------------

function reaches(body: DraftBody, extra: DraftWire, start: DraftKey, goal: DraftKey): boolean {
	const seen = new Set<string>();
	const walk = (key: DraftKey): boolean => {
		if (key === goal) return true;
		if (seen.has(key)) return false;
		seen.add(key);
		return [...body.wires, extra].some((w) => w.from.key === key && !backEdge(body, w) && walk(w.to.key));
	};
	return walk(start);
}

/** An operation's wire back to the sample it took in (in place): not an edge of the flow, or every pass would be a cycle. */
function backEdge(body: DraftBody, w: DraftWire): boolean {
	const from = itemOf(body, w.from.key);
	const to = itemOf(body, w.to.key);
	return from?.kind === 'operation' && to?.kind === 'sample' && inputSampleOf(body, { key: from.key, row: w.from.row ?? 0 }) === to.key;
}

/** Why `from` cannot be wired to `to`, in the words of the lab, or null when it can. */
export function wireProblem(body: DraftBody, from: WireEnd, to: WireEnd): string | null {
	const a = itemOf(body, from.key);
	const b = itemOf(body, to.key);
	if (!a || !b) return 'That card is not in the draft.';
	if (a.key === b.key) return 'A card cannot be wired to itself.';
	if (a.kind === 'test') return 'A test has no output to wire on.';
	const fromRow = a.kind === 'operation' ? (from.row ?? 0) : undefined;
	if (a.kind === 'operation' && fromRow! >= a.rows.length) return 'That operation has no such row.';
	const wire: DraftWire = norm(body, from, to);
	if (body.wires.some((w) => sameWire(w, wire))) return 'Those two are already wired.';
	if (a.kind === 'sample') {
		if (b.kind === 'sample') return 'Samples are joined through an operation: add one between them.';
		if (b.kind === 'operation') {
			if (b.existing && !b.attach) return 'Only an operation without an input sample can be attached.';
			if ((to.row ?? 0) >= b.rows.length) return 'That operation has no such row.';
			if (wireInto(body, b.key, to.row ?? 0)) return 'That input already has a sample.';
		} else if (b.existing) return 'A test that is already recorded keeps the samples it has.';
	} else if (b.kind === 'sample') {
		if (wiresOutOf(body, a.key, fromRow).some((w) => itemOf(body, w.to.key)?.kind === 'sample')) return 'That output already goes to a sample.';
		const input = inputSampleOf(body, { key: a.key, row: fromRow });
		if (b.key !== input) {
			if (b.existing) return 'That sample already exists with its own history: it cannot be made by this operation.';
			if (body.wires.some((w) => w.to.key === b.key && itemOf(body, w.from.key)?.kind === 'operation')) return 'That sample is already made by another operation.';
		}
	} else if (b.kind === 'operation') {
		if (b.existing && !b.attach) return 'Only an operation without an input sample can be attached.';
		if ((to.row ?? 0) >= b.rows.length) return 'That operation has no such row.';
		if (wireInto(body, b.key, to.row ?? 0)) return 'That input already has a sample.';
	} else if (b.existing) return 'A test that is already recorded keeps the samples it has.';
	if (!backEdge(body, wire) && reaches(body, wire, to.key, from.key)) return 'That would run in a circle.';
	return null;
}

/** A wire with the row of an operation end filled in (0), and none on samples and tests. */
function norm(body: DraftBody, from: WireEnd, to: WireEnd): DraftWire {
	const end = (e: WireEnd): WireEnd => (itemOf(body, e.key)?.kind === 'operation' ? { key: e.key, row: e.row ?? 0 } : { key: e.key });
	return { from: end(from), to: end(to) };
}

/** True when the two ends can be wired (the socket menu and the drag preview read this). */
export const canWire = (body: DraftBody, from: WireEnd, to: WireEnd): boolean => wireProblem(body, from, to) === null;

// ---- values ------------------------------------------------------------------------------------

/** What "new from" leaves behind: when it happened, which sample, notes, codes and the record's own bookkeeping. */
const NEW_FROM_DROPS = new Set([
	'operation_id', 'session_id', 'sample_id', 'output_sample_id', 'operation_date', 'session_date', 'planned_date', 'manufactured_date',
	'done_at', 'done_by_person_id', 'work_state', 'notes', 'sample_code', 'pass_code', 'test_code', 'operation_sequence', 'batch_id',
	'source_run_uid', 'current_status', 'date_created', 'date_updated', 'user_created', 'user_updated', 'created_at', 'updated_at',
	'created_by', 'updated_by', 'version',
]);

/** The fields of an existing record that a "new from" or duplicate of it keeps. */
export function newFromValues(values: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(values)) if (!NEW_FROM_DROPS.has(k) && v !== undefined) out[k] = v;
	return out;
}

// ---- building ----------------------------------------------------------------------------------

/** A body being built: mutated only inside `apply`, on a copy. */
interface Work {
	body: DraftBody;
}

const copyBody = (b: DraftBody): Work => ({
	body: { ...b, items: [...b.items], wires: [...b.wires], positions: { ...b.positions } },
});

function put(w: Work, item: DraftItem, at?: Pos, index?: number) {
	if (index === undefined) w.body.items.push(item);
	else w.body.items.splice(index, 0, item);
	if (at) w.body.positions[item.key] = { x: at.x, y: at.y };
}

/** Takes `n` keys at once: the item's, then those of its rows. Raises `seq` past them. */
const takeKeys = (w: Work, n: number): DraftKey[] => {
	const first = Number(nextKey(w.body).slice(1));
	w.body.seq = first + n - 1;
	return Array.from({ length: n }, (_, i) => `n${first + i}`);
};

function newSample(w: Work, values: Record<string, unknown>, at?: Pos, index?: number): DraftSample {
	const [key] = takeKeys(w, 1);
	const item: DraftSample = { key, kind: 'sample', values: { ...values } };
	put(w, item, at, index);
	return item;
}

function newOperation(
	w: Work,
	p: { values: Record<string, unknown>; workState: WorkState; rows?: number; attach?: DraftOperation['existing']; at?: Pos; index?: number },
): DraftOperation {
	const rows = Math.max(1, Math.floor(p.rows ?? 1));
	const [key, ...rowKeys] = takeKeys(w, 1 + rows);
	const item: DraftOperation = {
		key,
		kind: 'operation',
		workState: p.workState,
		values: { ...p.values },
		rows: rowKeys.map((k) => ({ key: k })),
		...(p.attach ? { existing: p.attach, attach: true as const } : {}),
	};
	put(w, item, p.at, p.index);
	return item;
}

/** Adds the wire when it fits; reports whether it did. */
function addWire(w: Work, from: WireEnd, to: WireEnd): boolean {
	if (wireProblem(w.body, from, to)) return false;
	w.body.wires.push(norm(w.body, from, to));
	return true;
}

/** A sample, or an operation or test, wired to the end `from` as an input: every row of an operation that has none. */
function wireInput(w: Work, from: WireEnd, item: DraftItem) {
	if (item.kind === 'operation') {
		item.rows.forEach((_, row) => addWire(w, from, { key: item.key, row }));
	} else addWire(w, from, { key: item.key });
}

/** The index after the original and the copies already placed after it. */
const indexAfter = (body: DraftBody, key: DraftKey) => {
	const i = body.items.findIndex((x) => x.key === key);
	return i < 0 ? undefined : i + 1;
};

/** The draft item of an existing record, added when it is not there yet. */
function existingSample(w: Work, ref: { id: string; version: number }): DraftSample {
	const have = w.body.items.find((i): i is DraftSample => i.kind === 'sample' && i.existing?.id === ref.id);
	if (have) return have;
	const [key] = takeKeys(w, 1);
	const item: DraftSample = { key, kind: 'sample', existing: { id: ref.id, version: ref.version }, values: {} };
	w.body.items.push(item);
	return item;
}

/** A pass: a new in-place operation on `sampleKey`, wired in and back out, placed after `after` (or last). */
function addPassTo(w: Work, sampleKey: DraftKey, p: { values: Record<string, unknown>; workState: WorkState; after?: DraftKey; at?: Pos }): DraftOperation {
	const op = newOperation(w, { values: p.values, workState: p.workState, at: p.at, index: p.after ? indexAfter(w.body, p.after) : undefined });
	addWire(w, { key: sampleKey }, { key: op.key, row: 0 });
	addWire(w, { key: op.key, row: 0 }, { key: sampleKey });
	return op;
}

/** Samples picked together land as a column from `at`; with no position they get none and the layout places them. */
const columnAt = (at: Pos | undefined, i: number): Pos | undefined => (at ? { x: at.x, y: at.y + i * COLUMN_GAP } : undefined);

function duplicateItem(w: Work, source: DraftItem, n: number, record?: Record<string, unknown>) {
	const base = source.existing ? newFromValues({ ...(record ?? {}), ...source.values }) : source.values;
	const origin = w.body.positions[source.key];
	const spot = (i: number): Pos | undefined => (origin ? { x: origin.x + (i + 1) * COPY_OFFSET, y: origin.y + (i + 1) * COPY_OFFSET } : undefined);
	// Wires are read from the body as it was, so the copies of one action all see the original's.
	const before = w.body;
	let index = indexAfter(before, source.key) ?? w.body.items.length;
	for (let i = 0; i < n; i += 1) {
		if (source.kind === 'sample') {
			newSample(w, base, spot(i), index);
		} else if (source.kind === 'test') {
			const copy: DraftTest = { key: takeKeys(w, 1)[0], kind: 'test', workState: source.workState, values: { ...base } };
			put(w, copy, spot(i), index);
			for (const s of subjectsOf(before, source.key)) addWire(w, { key: s }, { key: copy.key });
		} else if (isInPlace(before, source)) {
			// A pass: copies chain after the original on its sample, in order (sample → copy → sample).
			const sample = inputSampleOf(before, { key: source.key, row: 0 });
			if (sample) {
				const back = wiresOutOf(before, source.key, 0).some((x) => x.to.key === sample);
				const op = newOperation(w, { values: base, workState: source.workState, at: spot(i), index });
				addWire(w, { key: sample }, { key: op.key, row: 0 });
				if (back) addWire(w, { key: op.key, row: 0 }, { key: sample });
			} else {
				newOperation(w, { values: base, workState: source.workState, at: spot(i), index });
			}
		} else {
			// Anything else keeps the same input wires and gets open outputs of its own.
			const op = newOperation(w, { values: base, workState: source.workState, rows: source.rows.length, at: spot(i), index });
			source.rows.forEach((_, row) => {
				const sample = inputSampleOf(before, { key: source.key, row });
				if (sample) addWire(w, { key: sample }, { key: op.key, row });
			});
		}
		index += 1;
	}
}

function removeKey(body: DraftBody, key: DraftKey): DraftBody {
	const item = itemOf(body, key);
	if (!item) return body;
	const positions = { ...body.positions };
	delete positions[key];
	return {
		...body,
		items: body.items.filter((i) => i.key !== key),
		wires: body.wires.filter((x) => x.from.key !== key && x.to.key !== key),
		positions,
	};
}

// ---- the reducer ---------------------------------------------------------------------------------

export function apply(body: DraftBody, action: DraftAction): DraftBody {
	switch (action.type) {
		case 'addSample': {
			const w = copyBody(body);
			const sample = newSample(w, action.values ?? {}, action.at);
			if (action.from) addWire(w, action.from, { key: sample.key });
			return w.body;
		}
		case 'addExistingSamples': {
			const w = copyBody(body);
			let placed = 0;
			for (const s of action.samples) {
				if (w.body.items.some((i) => i.kind === 'sample' && i.existing?.id === s.id)) continue;
				const item: DraftSample = { key: takeKeys(w, 1)[0], kind: 'sample', existing: { id: s.id, version: s.version }, values: { ...(s.values ?? {}) } };
				put(w, item, columnAt(action.at, placed));
				placed += 1;
			}
			return placed ? w.body : body;
		}
		case 'addContainer': {
			const w = copyBody(body);
			const workState = action.workState ?? DEFAULT_WORK_STATE;
			const src = action.source;
			const values =
				src.from === 'blank'
					? action.kind === 'operation'
						? src.methodId ? { method_id: src.methodId } : {}
						: src.testType ? { test_type: src.testType } : {}
					: src.from === 'template'
						? { ...src.values }
						: newFromValues(src.values);
			let item: DraftOperation | DraftTest;
			if (action.kind === 'operation') {
				item = newOperation(w, { values, workState, rows: action.rows, at: action.at });
			} else {
				item = { key: takeKeys(w, 1)[0], kind: 'test', workState, values };
				put(w, item, action.at);
			}
			if (action.from) wireInput(w, action.from, item);
			return w.body;
		}
		case 'attach': {
			const w = copyBody(body);
			if (w.body.items.some((i) => i.kind === 'operation' && i.existing?.id === action.operation.id)) return body;
			const op = newOperation(w, { values: action.values ?? {}, workState: action.workState, attach: { ...action.operation }, at: action.at });
			if (action.from) wireInput(w, action.from, op);
			return w.body;
		}
		case 'addOutputRow': {
			const op = itemOf(body, action.key);
			if (op?.kind !== 'operation' || op.existing) return body;
			const w = copyBody(body);
			const [rowKey] = takeKeys(w, 1);
			const next: DraftOperation = { ...op, rows: [...op.rows, { key: rowKey }] };
			w.body.items[w.body.items.indexOf(op)] = next;
			// Every record of a cut has the one sample as its input: the new row takes it too.
			const first = wireInto(body, op.key, 0);
			if (first) w.body.wires.push({ from: { ...first.from }, to: { key: op.key, row: next.rows.length - 1 } });
			return w.body;
		}
		case 'addPass': {
			const w = copyBody(body);
			let sampleKey: DraftKey;
			if ('key' in action.sample) {
				if (itemOf(body, action.sample.key)?.kind !== 'sample') return body;
				sampleKey = action.sample.key;
			} else sampleKey = existingSample(w, action.sample).key;
			const prior = action.after ? itemOf(body, action.after) : undefined;
			if (action.after && prior?.kind !== 'operation') return body;
			const values = action.values ? newFromValues(action.values) : prior ? { ...prior.values } : {};
			addPassTo(w, sampleKey, { values, workState: action.workState ?? (prior?.kind === 'operation' ? prior.workState : DEFAULT_WORK_STATE), after: action.after, at: action.at });
			return w.body;
		}
		case 'wire': {
			const w = copyBody(body);
			const target = itemOf(body, action.to.key);
			let did = false;
			// A sample wired to a whole operation feeds every row that has no input yet; an output is one row's.
			if (target?.kind === 'operation' && action.to.row === undefined) {
				target.rows.forEach((_, row) => {
					did = addWire(w, action.from, { key: target.key, row }) || did;
				});
			} else did = addWire(w, action.from, action.to);
			return did ? w.body : body;
		}
		case 'unwire': {
			const gone = norm(body, action.from, action.to);
			const wires = body.wires.filter((x) => !sameWire(x, gone));
			return wires.length === body.wires.length ? body : { ...body, wires };
		}
		case 'setValues': {
			const item = itemOf(body, action.key);
			if (!item) return body;
			const values = { ...item.values };
			let changed = false;
			for (const [k, v] of Object.entries(action.values)) {
				if (v === undefined) {
					if (k in values) {
						delete values[k];
						changed = true;
					}
				} else if (values[k] !== v) {
					values[k] = v;
					changed = true;
				}
			}
			return changed ? { ...body, items: body.items.map((i) => (i === item ? { ...i, values } : i)) } : body;
		}
		case 'setWorkState': {
			const item = itemOf(body, action.key);
			if (!item || item.kind === 'sample' || item.workState === action.workState) return body;
			return { ...body, items: body.items.map((i) => (i === item ? { ...item, workState: action.workState } : i)) };
		}
		case 'duplicate': {
			const source = itemOf(body, action.key);
			if (!source || source.remove) return body;
			const n = Math.min(99, Math.max(1, Math.floor(action.n ?? 1)));
			const w = copyBody(body);
			duplicateItem(w, source, n, action.record);
			return w.body;
		}
		case 'remove': {
			const item = itemOf(body, action.key);
			if (!item) return body;
			// A planned record that exists is deleted at Create (E18): it stays in the draft, marked, with its wires.
			if (item.existing && action.deleteRecord) {
				if (item.remove) return body;
				return { ...body, items: body.items.map((i) => (i === item ? { ...item, remove: true as const } : i)) };
			}
			return removeKey(body, action.key);
		}
		case 'move': {
			const at = body.positions[action.key];
			if (!itemOf(body, action.key) || (at && at.x === action.x && at.y === action.y)) return body;
			return { ...body, positions: { ...body.positions, [action.key]: { x: action.x, y: action.y } } };
		}
		case 'setProject':
			return body.projectId === action.projectId ? body : { ...body, projectId: action.projectId };
		case 'setCampaign':
			return body.campaignId === action.campaignId ? body : { ...body, campaignId: action.campaignId };
	}
}
