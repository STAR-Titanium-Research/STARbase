// Shareable Plot view: the dashboard's navigable state <-> the route query, so the address bar is
// always a link that reopens the same view. Both hosts (the standalone app and the Directus
// module) run vue-router, so this stays pure: strings in, strings out, no router import.
//
// Parsing is defensive by design. A link outlives the release that wrote it and can be edited by
// hand or truncated by a chat client, so anything unknown or malformed is dropped (that field
// falls back to the dashboard's default) and nothing here ever throws.

import type { FrmMode } from './frmMode';

export const CHART_MODE_KEYS = ['force', 'fft', 'psd', 'spectrogram', 'waterfall'] as const;
export type ViewChartMode = (typeof CHART_MODE_KEYS)[number];
export const VIEW_AXES = ['Fx', 'Fy', 'Fz'] as const;
export type ViewAxis = (typeof VIEW_AXES)[number];
export const VIEW_FRM_MODES: readonly FrmMode[] = ['figure', 'lite', 'full'];
export const VIEW_Z_SERIES = ['none', 'Fx', 'Fy', 'Fz'] as const;
export type ViewZSeries = (typeof VIEW_Z_SERIES)[number];

export interface ViewState {
	/** operation_id (the human-visible id the `?operation=` deep link has always used). */
	operation: string;
	mode: ViewChartMode;
	axis: ViewAxis;
	/** Shared chart x-window, in x-units (seconds in Force mode, Hz in FFT). */
	zoom: [number, number];
	/** Live crop-preview window in seconds (only written while it differs from the saved crop). */
	crop: [number, number];
	/** Row ids of the cuts overlaid in Compare. */
	compare: string[];
	/** The compare chip marked as the difference reference. */
	reference: string;
	diff: boolean;
	frm: FrmMode;
	zSeries: ViewZSeries;
	/** Locked colour-scale saturation range. Present only while the scale is locked. */
	scale: [number, number];
}

// Compact keys. `operation` keeps its original spelling so existing deep links (the "View Force
// Analysis" button on the operation form) keep working.
const K = {
	operation: 'operation', mode: 'm', axis: 'ax', zoom: 'z', crop: 'crop', compare: 'cmp',
	reference: 'ref', diff: 'diff', frm: 'fm', zSeries: 'zs', scale: 'cs',
} as const;

/** Every query key this module owns; the host strips these before merging, so unrelated
 *  query parameters survive a write-back. */
export const VIEW_QUERY_KEYS: readonly string[] = Object.values(K);

const DEFAULTS = { mode: 'force', axis: 'Fz', zSeries: 'none' } as const;
const MAX_COMPARE = 5;
const MAX_ID_LEN = 128;

/** The Plot page lets any number of cuts be compared (the colours just cycle), but a link keeps a
 *  bounded list so it stays short enough to paste. The reference is always kept: dropping it would
 *  silently turn the Difference off for the recipient. */
export function capCompare(ids: readonly string[], reference: string | undefined, max = MAX_COMPARE): string[] {
	const list = ids.filter(validId);
	const kept = list.slice(0, max);
	if (reference && list.includes(reference) && !kept.includes(reference)) {
		kept.pop();
		kept.push(reference);
	}
	return kept;
}

const num = (n: number) => String(+n.toPrecision(7));
const pairOut = (p: readonly [number, number]) => `${num(p[0])},${num(p[1])}`;

function pairIn(v: string | undefined): [number, number] | undefined {
	if (!v) return undefined;
	const parts = v.split(',');
	if (parts.length !== 2 || parts[0].trim() === '' || parts[1].trim() === '') return undefined;
	const a = Number(parts[0]), b = Number(parts[1]);
	return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined;
}

const validPair = (p: unknown): p is [number, number] =>
	Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x));

function oneOf<T extends string>(list: readonly T[], v: string | undefined): T | undefined {
	return v !== undefined && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}

// Ids travel comma-joined, so a comma (or whitespace) in one would corrupt the list.
const validId = (s: unknown): s is string =>
	typeof s === 'string' && s.length > 0 && s.length <= MAX_ID_LEN && !/[,\s]/.test(s);

/** Serialise a view. Fields left undefined, invalid or equal to the dashboard default are
 *  omitted, so a default view produces a short (or empty) query. */
export function encodeViewState(state: Partial<ViewState>): Record<string, string> {
	const q: Record<string, string> = {};
	if (typeof state.operation === 'string' && state.operation && state.operation.length <= MAX_ID_LEN) {
		q[K.operation] = state.operation;
	}
	if (state.mode && state.mode !== DEFAULTS.mode && oneOf(CHART_MODE_KEYS, state.mode)) q[K.mode] = state.mode;
	if (state.axis && state.axis !== DEFAULTS.axis && oneOf(VIEW_AXES, state.axis)) q[K.axis] = state.axis;
	if (validPair(state.zoom) && state.zoom[1] > state.zoom[0]) q[K.zoom] = pairOut(state.zoom);
	if (validPair(state.crop) && state.crop[1] > state.crop[0]) q[K.crop] = pairOut(state.crop);
	const cmp = capCompare(state.compare ?? [], state.reference);
	if (cmp.length) q[K.compare] = cmp.join(',');
	if (validId(state.reference) && cmp.includes(state.reference)) q[K.reference] = state.reference;
	if (state.diff && q[K.reference]) q[K.diff] = '1';
	if (state.frm && oneOf(VIEW_FRM_MODES, state.frm)) q[K.frm] = state.frm;
	if (state.zSeries && state.zSeries !== DEFAULTS.zSeries && oneOf(VIEW_Z_SERIES, state.zSeries)) q[K.zSeries] = state.zSeries;
	if (validPair(state.scale) && state.scale[1] > state.scale[0]) q[K.scale] = pairOut(state.scale);
	return q;
}

type QueryIn = Record<string, unknown> | null | undefined;

// vue-router hands back string | (string | null)[] | null; a repeated key takes its first value.
function first(query: QueryIn, key: string): string | undefined {
	const v = query?.[key];
	const s = Array.isArray(v) ? v[0] : v;
	return typeof s === 'string' ? s : undefined;
}

/** Parse a route query into the fields that are present and valid. Never throws. */
export function decodeViewState(query: QueryIn): Partial<ViewState> {
	const out: Partial<ViewState> = {};
	try {
		const op = first(query, K.operation);
		if (op && op.length <= MAX_ID_LEN) out.operation = op;
		const mode = oneOf(CHART_MODE_KEYS, first(query, K.mode));
		if (mode) out.mode = mode;
		const axis = oneOf(VIEW_AXES, first(query, K.axis));
		if (axis) out.axis = axis;
		const zoom = pairIn(first(query, K.zoom));
		if (zoom && zoom[1] > zoom[0]) out.zoom = zoom;
		const crop = pairIn(first(query, K.crop));
		if (crop && crop[1] > crop[0] && crop[0] >= 0) out.crop = crop;
		const cmpRaw = first(query, K.compare);
		if (cmpRaw) {
			const ids = [...new Set(cmpRaw.split(',').filter(validId))].slice(0, MAX_COMPARE);
			if (ids.length) out.compare = ids;
		}
		const ref = first(query, K.reference);
		if (validId(ref) && out.compare?.includes(ref)) out.reference = ref;
		if (first(query, K.diff) === '1' && out.reference) out.diff = true;
		const frm = oneOf(VIEW_FRM_MODES, first(query, K.frm));
		if (frm) out.frm = frm;
		const zs = oneOf(VIEW_Z_SERIES, first(query, K.zSeries));
		if (zs) out.zSeries = zs;
		const scale = pairIn(first(query, K.scale));
		if (scale && scale[1] > scale[0]) out.scale = scale;
	} catch { /* a hostile query object: whatever parsed so far stands */ }
	return out;
}

export type IncomingViewDecision =
	| { action: 'apply'; view: Partial<ViewState> }
	| { action: 'write' };

/** What a kept-alive Plot page does when it is activated, or its route changes while active.
 *  'apply': the route names a different operation or view than the one on screen (an in-app push
 *  to `/plot?operation=X`), so show it. 'write': the route carries no view keys, or only what is
 *  already shown, so the address bar should follow the page instead. Keys the route omits never
 *  count as a difference: a bare `?operation=X` while X is shown must not reset the view. */
export function incomingViewDecision(query: QueryIn, current: Partial<ViewState>): IncomingViewDecision {
	const view = decodeViewState(query);
	const incoming = encodeViewState(view);
	const shown = encodeViewState(current);
	const differs = Object.keys(incoming).some((k) => incoming[k] !== shown[k]);
	return differs ? { action: 'apply', view } : { action: 'write' };
}
