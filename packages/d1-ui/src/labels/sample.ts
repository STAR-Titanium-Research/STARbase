// A physical_samples row as the labels page reads it -> what a label shows.
import type { LabelSample } from './types';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

// "Ada Lovelace" -> "AL"; "ada" -> "A"; empty / unreadable -> ''.
export function initials(fullName: unknown): string {
	const words = text(fullName).split(/\s+/).filter(Boolean);
	if (!words.length) return '';
	const picks = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
	return picks.map((w) => Array.from(w)[0].toUpperCase()).join('');
}

export const DEFAULT_TIMEZONE = 'Europe/London';

// ISO date (YYYY-MM-DD) for a DATE string or a timestamp; '' when absent or invalid. A DATE string is
// used as is. A timestamp is read in `timeZone`, so a sample created just after local midnight shows
// that day and not the previous UTC day.
export function labelDate(manufactured: unknown, created: unknown, timeZone = DEFAULT_TIMEZONE): string {
	const v = manufactured || created;
	if (!v) return '';
	if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
	const d = new Date(v as string);
	if (Number.isNaN(d.getTime())) return '';
	const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
	const get = (type: string) => parts.find((p) => p.type === type)?.value;
	return `${get('year')}-${get('month')}-${get('day')}`;
}

function materialName(row: Row): string {
	const rel = row.material_id;
	if (isRow(rel)) return text(rel.common_name) || text(rel.alloy_code);
	return text(row.material);
}

function ownerInitials(row: Row): string {
	const rel = row.owner_person_id;
	if (isRow(rel)) return initials(rel.full_name);
	return text(row.owner_initials).toUpperCase();
}

// Reads: sample_id, sample_code, short_id, nickname, material_id.common_name / alloy_code (or a flat
// `material`), manufactured_date, created_at, owner_person_id.full_name (or a flat `owner_initials`).
// A missing short_id falls back to the first 8 hex characters of the id, which is how short ids are
// assigned (a clash lengthens it, but the column is always set).
export function toLabelSample(row: Row): LabelSample {
	const id = text(row.sample_id).toLowerCase();
	return {
		id,
		code: text(row.sample_code),
		shortId: text(row.short_id).toLowerCase() || id.replace(/-/g, '').slice(0, 8),
		nickname: text(row.nickname) || null,
		material: materialName(row) || null,
		date: labelDate(row.manufactured_date, row.created_at) || null,
		ownerInitials: ownerInitials(row) || null,
	};
}

// A label needs a readable code and a short id (8 to 32 lower-case hex characters): without them the QR
// payload could not be read back. The renderer skips samples that fail this and counts them.
export function isPrintableSample(s: LabelSample): boolean {
	return s.code.trim() !== '' && /^[0-9a-f]{8,32}$/.test(s.shortId);
}
