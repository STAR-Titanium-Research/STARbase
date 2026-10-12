import { parseQrPayload, QR_HEADER } from '../labels/qrPayload';
import { recordRoute } from '../recordRoute';

// Reading a scanned label (a USB scanner typing into the Finder, a paste, or the camera dialog):
// recognise the `D1 SAMPLE` payload, find the sample it names and say where to go, or why not.
// Pure and host-neutral: the caller passes anything with a `get` like the ExplorerHost's api.

export interface ScanApi {
	get(path: string, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
}

export type FailReason = 'not_found' | 'no_access' | 'network' | 'error';

export type ScanOutcome =
	// The sample was found: go to `to`.
	| { kind: 'open'; to: string; code: string }
	// A D1 label whose sample could not be opened. The decoded label text is kept so it can be shown.
	| { kind: 'failed'; reason: FailReason; message: string; code: string; shortId: string; lines: string[] }
	// Not a D1 sample label (or an unreadable one): the text as scanned.
	| { kind: 'text'; text: string; looksLikeD1: boolean };

// A scanner types its Enter as CR (or LF, or CRLF); the first line of a label is fixed, so that is
// how a scan in progress is recognised before the rest has arrived.
export function isScanStarted(text: string): boolean {
	return typeof text === 'string' && text.trimStart().split(/\r\n|\r|\n/, 1)[0].trim() === QR_HEADER;
}

// Line breaks as LF, edges trimmed. A paste or scan is one value, not several submissions.
export function normalizeScan(text: string): string {
	return text.replace(/\r\n|\r/g, '\n').trim();
}

// A box that still holds an earlier scan (a failed one stays on screen) gets the next label appended:
// the label is what follows the LAST header line. Text that does not start with a header is unchanged.
export function fromLastHeader(text: string): string {
	const normalized = normalizeScan(text);
	const lines = normalized.split('\n');
	if (lines[0].trim() !== QR_HEADER) return normalized;
	let last = 0;
	lines.forEach((l, i) => {
		if (l.trim() === QR_HEADER) last = i;
	});
	return lines.slice(last).join('\n');
}

const MAX_SHOWN = 1000;

// Text from a QR code or scanner for display: control characters (other than line breaks and tabs)
// are shown as \xNN so nothing invisible is hidden in it, and a very long payload is cut. It is shown
// as plain text (never as HTML or a link), so a code that says "http://evil" is not clickable.
export function displayText(raw: string): string {
	// eslint-disable-next-line no-control-regex
	const escaped = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
	return escaped.length > MAX_SHOWN ? `${escaped.slice(0, MAX_SHOWN)}…` : escaped;
}

const SAMPLE_FIELDS = ['sample_id', 'sample_code', 'short_id'];

function failure(err: any): { reason: FailReason; message: string } {
	const status = err?.response?.status;
	if (status === 401 || status === 403) {
		return { reason: 'no_access', message: 'You do not have access to samples, or your session has expired.' };
	}
	if (!err?.response) {
		return { reason: 'network', message: 'The server could not be reached. Check the connection and scan again.' };
	}
	return { reason: 'error', message: `The server could not look the sample up (error ${status ?? 'unknown'}).` };
}

// A D1 label's sample: by short id first (it never changes), then by sample code (a label printed
// before the code was renamed still opens through its short id; one printed by hand may have only
// the code). Reads as the signed-in user, so a deleted sample and one the user may not see look the same.
export async function resolveLabel(api: ScanApi, text: string): Promise<ScanOutcome> {
	const raw = fromLastHeader(text);
	const parsed = parseQrPayload(raw);
	if (!parsed) return { kind: 'text', text: raw, looksLikeD1: isScanStarted(raw) };
	const label = { code: parsed.code, shortId: parsed.shortId, lines: parsed.lines };

	const find = async (filter: Record<string, unknown>): Promise<any | undefined> => {
		const res = await api.get('/items/physical_samples', { params: { fields: SAMPLE_FIELDS, filter: JSON.stringify(filter), limit: 1 } });
		const rows = res.data?.data;
		return Array.isArray(rows) ? rows[0] : undefined;
	};
	const open = (row: any): ScanOutcome => ({ kind: 'open', to: recordRoute('physical_samples', row.sample_id), code: String(row.sample_code ?? parsed.code) });

	try {
		const byShortId = await find({ short_id: { _eq: parsed.shortId } });
		if (byShortId?.sample_id) return open(byShortId);
		const byCode = await find({ sample_code: { _eq: parsed.code } });
		if (byCode?.sample_id) return open(byCode);
	} catch (err) {
		return { kind: 'failed', ...failure(err), ...label };
	}
	return {
		kind: 'failed',
		reason: 'not_found',
		message: 'No sample matches this label. It may have been deleted, or you may not have access to it.',
		...label,
	};
}
