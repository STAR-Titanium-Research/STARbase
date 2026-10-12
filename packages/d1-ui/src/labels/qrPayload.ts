// The self-describing text a label's QR code holds, readable by any phone with no network or login:
//
//   D1 SAMPLE
//   S-0123 · 1a2b3c4d
//   Ti-6Al-4V · "bracket A"
//   2026-10-01 · DP
//
// The first line is fixed (so it can be recognised and versioned). The code and short id are always
// there; the template picks the other values through its qrFields.
import type { FieldKey, LabelSample } from './types';

export const QR_HEADER = 'D1 SAMPLE';
const SEP = ' · ';

// One value on one line: line breaks and tabs become spaces so the line structure survives.
const oneLine = (v: string): string => v.replace(/\s+/g, ' ').trim();

export function buildQrPayload(s: LabelSample, extraKeys: readonly FieldKey[]): string {
	const want = new Set(extraKeys);
	const pick = (key: FieldKey, value: string | null, wrap = (v: string) => v): string | null => {
		if (!want.has(key) || !value) return null;
		const v = oneLine(value);
		return v ? wrap(v) : null;
	};
	const join = (parts: (string | null)[]): string => parts.filter((p): p is string => p !== null).join(SEP);

	return [
		QR_HEADER,
		`${oneLine(s.code)}${SEP}${oneLine(s.shortId)}`,
		join([pick('material', s.material), pick('nickname', s.nickname, (v) => `"${v}"`)]),
		join([pick('date', s.date), pick('owner_initials', s.ownerInitials)]),
	]
		.filter((line) => line !== '')
		.join('\n');
}

export interface ParsedQrPayload {
	code: string;
	shortId: string;
	// The lines after the code line (material / nickname, date / owner...), as printed. Empty lines dropped.
	lines: string[];
}

// null for anything that is not a D1 sample payload: wrong or missing header, or no `<code> · <short id>`
// line (the short id is 8 to 32 lower-case hex characters, so a code containing the separator still parses).
export function parseQrPayload(text: string): ParsedQrPayload | null {
	if (typeof text !== 'string') return null;
	const lines = text.trim().split(/\r\n|\r|\n/).map((l) => l.trim());
	if (lines[0] !== QR_HEADER) return null;
	// " · " is what labels print; USB (HID) scanners cannot type "·", so " - " and " | " are read too.
	const m = /^(.+) (?:·|-|\|) ([0-9a-f]{8,32})$/.exec(lines[1] ?? '');
	if (!m) return null;
	return { code: m[1], shortId: m[2], lines: lines.slice(2).filter(Boolean) };
}
