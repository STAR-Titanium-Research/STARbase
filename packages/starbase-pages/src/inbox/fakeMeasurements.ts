// The saved-measurement routes of the fake d1-inbox (fakeInboxServer.ts), as the endpoint answers them (core/extensions/d1-inbox/index.js, migration 211):
//   GET    /d1-inbox/files/<id>/measurements        { data: SavedMeasurement[], meta: { total, can_change } }  oldest first; 404 NOT_FOUND for a file the fake does not hold
//   POST   /d1-inbox/files/<id>/measurements        { kind, points, label? } -> { data: SavedMeasurement } (the real endpoint's status is 201); 400 INVALID_PAYLOAD
//                                                   (extensions.field kind | points | label), 403 FORBIDDEN when the caller only reads, 409 TOO_MANY_MEASUREMENTS at 200
//   PATCH  /d1-inbox/files/<id>/measurements/<mid>  { label } -> { data: SavedMeasurement }; 403 FORBIDDEN unless the row says can_edit, 404 for a row of another file
//   DELETE /d1-inbox/files/<id>/measurements/<mid>  -> { data: { measurement_id } }
// The points are in pixels of the ORIGINAL image and the fake never looks at them beyond the checks the server makes (the maths is the client's). Options:
// `measurements` (shapes already saved, by candidate id), `measureReadOnly` (the caller reads but does not own: a save is 403, can_change false, each row's
// can_edit as seeded, default false), `measureFails` (every request is a 500: a server that is down, or a migration not applied yet).
import type { FoundFile, MeasurementKind, SavedMeasurement } from './inboxApi';

export interface FakeMeasurementOptions {
	measurements?: Record<string, SavedMeasurement[]>;
	measureReadOnly?: boolean;
	measureFails?: boolean;
}

const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
	Object.assign(new Error(`Request failed with status code ${status}`), {
		response: { status, data: { errors: [{ message, extensions: { ...extra, code, source: 'd1-inbox' } }] } },
	});
const bad = (field: string, message: string) => err(400, 'INVALID_PAYLOAD', message, { field });

const KINDS: readonly string[] = ['line', 'circle', 'polygon'];
const MAX = 200;
const hasOnly = (o: unknown, keys: string[]): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));

function label(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (typeof v !== 'string') throw bad('label', 'The name must be text.');
	const out = v.trim();
	if (out.length > 120) throw bad('label', 'The name is too long (at most 120 characters).');
	return out;
}

/** The checks the endpoint's parseMeasurement makes. */
function parseNew(body: unknown): { kind: MeasurementKind; points: Array<{ x: number; y: number }>; label: string } {
	if (!hasOnly(body, ['kind', 'points', 'label'])) throw err(400, 'INVALID_PAYLOAD', 'The request must be { "kind", "points", "label" } and nothing else.');
	if (typeof body.kind !== 'string' || !KINDS.includes(body.kind)) throw bad('kind', 'The shape must be a line, a circle or a polygon.');
	if (!Array.isArray(body.points)) throw bad('points', 'points must be a list of corners.');
	const [lo, hi] = body.kind === 'polygon' ? [3, 200] : [2, 2];
	if (body.points.length < lo || body.points.length > hi) throw bad('points', body.kind === 'polygon' ? 'A polygon has 3 to 200 corners.' : `A ${body.kind} has 2 points.`);
	const points = body.points.map((p: unknown) => {
		const ok = hasOnly(p, ['x', 'y']) && ['x', 'y'].every((k) => typeof p[k] === 'number' && Number.isFinite(p[k] as number) && (p[k] as number) >= 0 && (p[k] as number) <= 1_000_000);
		if (!ok) throw bad('points', 'Each corner must be { "x", "y" }, two numbers from 0 to 1000000.');
		const q = p as { x: number; y: number };
		return { x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 };
	});
	if (body.kind !== 'polygon' && points[0].x === points[1].x && points[0].y === points[1].y) throw bad('points', 'The two points are on the same spot.');
	return { kind: body.kind as MeasurementKind, points, label: label(body.label) };
}

export function createFakeMeasurements(init: { opts: FakeMeasurementOptions; files: FoundFile[]; now: () => number; author?: string }) {
	const { opts, files, now } = init;
	const author = init.author ?? 'Ann Lee';
	const store = new Map<string, SavedMeasurement[]>(Object.entries(JSON.parse(JSON.stringify(opts.measurements ?? {})) as Record<string, SavedMeasurement[]>));
	let seq = 0;
	const rows = (candidate: string) => store.get(candidate) ?? [];
	const file = (candidate: string) => {
		if (opts.measureFails) throw err(500, 'INTERNAL_SERVER_ERROR', 'Something went wrong on the server.');
		if (!files.some((f) => f.candidate_id === candidate && f.state !== 'gone')) throw err(404, 'NOT_FOUND', 'That file is not in your inbox.');
	};
	const one = (candidate: string, id: string): SavedMeasurement => {
		const m = rows(candidate).find((x) => x.measurement_id === id);
		if (!m) throw err(404, 'NOT_FOUND', 'That measurement does not exist.');
		return m;
	};
	const canChange = () => opts.measureReadOnly !== true;

	/** The handler of one measurement request, or undefined for a method the route does not have. */
	function handler(method: string, candidate: string, id: string | null): ((body: unknown) => unknown) | undefined {
		if (id === null && method === 'get') {
			return () => {
				file(candidate);
				const list = rows(candidate);
				return { data: list, meta: { total: list.length, can_change: canChange() } };
			};
		}
		if (id === null && method === 'post') {
			return (body) => {
				const input = parseNew(body);
				file(candidate);
				if (!canChange()) throw err(403, 'FORBIDDEN', 'You can read the measurements of this file but not change them.');
				if (rows(candidate).length >= MAX) throw err(409, 'TOO_MANY_MEASUREMENTS', `A file can hold at most ${MAX} measurements. Delete one first.`, { limit: MAX });
				seq += 1;
				const saved: SavedMeasurement = {
					measurement_id: `e${String(seq).padStart(7, '0')}-0000-4000-8000-000000000000`, ...input, created_at: new Date(now() + seq).toISOString(), author_name: author, can_edit: true,
				};
				store.set(candidate, [...rows(candidate), saved]);
				return { data: saved };
			};
		}
		if (id !== null && method === 'patch') {
			return (body) => {
				if (!hasOnly(body, ['label']) || !('label' in body)) throw err(400, 'INVALID_PAYLOAD', 'The request must be { "label": <a name> } and nothing else.');
				const next = label(body.label);
				file(candidate);
				const m = one(candidate, id);
				if (!m.can_edit) throw err(403, 'FORBIDDEN', 'Only the owner of the file or the person who saved a measurement can change it.');
				m.label = next;
				return { data: m };
			};
		}
		if (id !== null && method === 'delete') {
			return () => {
				file(candidate);
				const m = one(candidate, id);
				if (!m.can_edit) throw err(403, 'FORBIDDEN', 'Only the owner of the file or the person who saved a measurement can change it.');
				store.set(candidate, rows(candidate).filter((x) => x !== m));
				return { data: { measurement_id: id } };
			};
		}
		return undefined;
	}

	return { handler, store };
}
