// The edit frame's messages (spec §3.4). d1-server's form-only page /admin/d1-edit/<collection>/<id>
// tells the window that opened it (STARbase's edit dialog, or the STARbase tab that opened it as a new
// tab) that it is ready, saved or cancelled. Origins are checked both ways:
//   - the frame posts only to STARbase's origin as d1-server knows it (GET /d1-links → STARBASE_URL,
//     loadTargetOrigin / targetOriginFrom), through frameTell, never to '*' and never to an origin taken
//     from its own URL (anyone can write a URL; frame-ancestors only limits framing, not the new-tab path);
//   - STARbase reads only messages from d1-server's origin, from its own frame or tab, about the record
//     it opened (readEditMessage).

export const EDIT_MESSAGE_TYPE = 'd1-edit';
// Data Studio's id for "a new record".
export const NEW_ITEM_ID = '+';

export type EditResult = 'ready' | 'saved' | 'cancelled';

export interface EditMessage {
	type: typeof EDIT_MESSAGE_TYPE;
	result: EditResult;
	collection: string;
	id: string;
}

export interface ExpectedEditSource {
	origin: string;
	source: unknown;
	collection: string;
	id: string;
}

export interface MessageTarget {
	postMessage(message: unknown, targetOrigin: string): void;
}

export function editFrameUrl(serverBase: string, collection: string, id: string): string {
	const base = serverBase.replace(/\/+$/, '');
	const key = id === NEW_ITEM_ID ? NEW_ITEM_ID : encodeURIComponent(id);
	return `${base}/admin/d1-edit/${encodeURIComponent(collection)}/${key}`;
}

// The origin the frame may post to: that of GET /d1-links' starbaseUrl (STARBASE_URL), or null when it is
// unset or not an http(s) address.
export function targetOriginFrom(starbaseUrl: unknown): string | null {
	if (typeof starbaseUrl !== 'string' || starbaseUrl.trim() === '') return null;
	try {
		const u = new URL(starbaseUrl.trim());
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
	} catch {
		return null;
	}
}

// Asks d1-server where STARbase is (GET /d1-links) and returns the origin to post to, or null: unset,
// not an http(s) address, or the request failed. The only source of the frame's target origin.
export async function loadTargetOrigin(api: { get(path: string): Promise<{ data?: any }> }): Promise<string | null> {
	try {
		const res = await api.get('/d1-links');
		return targetOriginFrom(res?.data?.starbaseUrl);
	} catch {
		return null;
	}
}

// The frame's only way to post: to `target` (the framing page, or window.opener in a new tab) at exactly
// `targetOrigin`. Without either, nothing is posted, and the frame shows its own "Saved" instead.
export function frameTell(target: MessageTarget | null | undefined, targetOrigin: string | null, message: EditMessage): boolean {
	if (!target || !targetOrigin) return false;
	target.postMessage(message, targetOrigin);
	return true;
}

export function editMessage(result: EditResult, collection: string, id: string): EditMessage {
	return { type: EDIT_MESSAGE_TYPE, result, collection, id };
}

// The frame's `tell(result, id?)`: to the page framing it (`parent`) when framed, else to the STARbase tab
// that opened it (`opener`), and only at the origin `targetOrigin()` gives (from loadTargetOrigin). The
// origin and the windows are read at each call, so ones that arrive after mount are used. false = nobody was told.
export function frameReporter(opts: {
	framed: boolean;
	parent: () => MessageTarget | null | undefined;
	opener: () => MessageTarget | null | undefined;
	targetOrigin: () => string | null;
	collection: string;
	id: () => string;
}): (result: EditResult, id?: string) => boolean {
	return (result, id) =>
		frameTell(opts.framed ? opts.parent() : opts.opener(), opts.targetOrigin(), editMessage(result, opts.collection, id ?? opts.id()));
}

export function isEditMessage(data: unknown): data is EditMessage {
	if (!data || typeof data !== 'object') return false;
	const d = data as Record<string, unknown>;
	return (
		d.type === EDIT_MESSAGE_TYPE &&
		(d.result === 'ready' || d.result === 'saved' || d.result === 'cancelled') &&
		typeof d.collection === 'string' &&
		typeof d.id === 'string'
	);
}

// A message STARbase may act on, or null. A new record ('+') comes back 'saved' under its new id.
export function readEditMessage(event: { origin: string; source: unknown; data: unknown }, expected: ExpectedEditSource): EditMessage | null {
	if (event.origin !== expected.origin) return null;
	if (!expected.source || event.source !== expected.source) return null;
	if (!isEditMessage(event.data)) return null;
	const m = event.data;
	if (m.collection !== expected.collection) return null;
	const sameRecord = m.id === expected.id || (expected.id === NEW_ITEM_ID && m.result === 'saved');
	return sameRecord ? m : null;
}
