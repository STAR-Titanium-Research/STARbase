// label_templates rows -> LabelTemplate, and the checks the template editor shows.
import {
	ARRANGEMENTS, FIELD_KEYS, FIELD_SIZES, MEDIA, QR_KEYS,
	type Arrangement, type FieldKey, type LabelField, type LabelTemplate, type Media, type QrKey,
} from './types';

type Row = Record<string, unknown>;

// Slack for float sums such as 4 x 52.5 against a 210 mm page.
export const EPS = 0.01;

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

// Directus returns numeric columns as strings.
function num(v: unknown): number | null {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v === 'string' && v.trim() !== '') {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

// jsonb comes back parsed, but accept JSON text too (an editor textarea, a CSV import).
function jsonArray(v: unknown): unknown[] {
	if (Array.isArray(v)) return v;
	if (typeof v === 'string') {
		try {
			const parsed: unknown = JSON.parse(v);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}
	return [];
}

function parseFields(v: unknown): LabelField[] {
	const out: LabelField[] = [];
	for (const item of jsonArray(v)) {
		if (!isRow(item) || !FIELD_KEYS.includes(item.key as FieldKey)) continue;
		out.push({
			key: item.key as FieldKey,
			size: FIELD_SIZES.includes(item.size as LabelField['size']) ? (item.size as LabelField['size']) : 'md',
			bold: item.bold === true,
		});
	}
	return out;
}

// The QR extras of a template. An empty or missing list (a row from before the QR carried everything, or a NULL)
// means all of them, so the editor and the payload agree. Unknown entries, and the always-on sample_code and
// short_id, are dropped.
function parseQrKeys(v: unknown): QrKey[] {
	const out: QrKey[] = [];
	for (const item of jsonArray(v)) if (QR_KEYS.includes(item as QrKey) && !out.includes(item as QrKey)) out.push(item as QrKey);
	return out.length ? out : [...QR_KEYS];
}

// Reads a label_templates row (snake_case, numerics as strings or numbers). Optional columns get the
// table's defaults; unknown entries in the jsonb lists are dropped. THROWS an Error naming the
// column when a required one is unusable (non-numeric geometry, unknown media or arrangement), because
// the table's constraints make that a corrupt row rather than something a user can fix. Semantic
// checks (grid off the page...) are validateTemplate's job.
export function templateFromRow(row: Row): LabelTemplate {
	const problems: string[] = [];
	const required = (key: string): number => {
		const n = num(row[key]);
		if (n === null) problems.push(`${key} is not a number`);
		return n ?? 0;
	};
	const optional = (key: string, fallback: number): number => {
		if (row[key] === null || row[key] === undefined || row[key] === '') return fallback;
		const n = num(row[key]);
		if (n === null) problems.push(`${key} is not a number`);
		return n ?? fallback;
	};
	const media = row.media as Media;
	if (!MEDIA.includes(media)) problems.push(`media must be one of ${MEDIA.join(', ')}`);
	const arrangement = row.arrangement as Arrangement;
	if (!ARRANGEMENTS.includes(arrangement)) problems.push(`arrangement must be one of ${ARRANGEMENTS.join(', ')}`);

	const t: LabelTemplate = {
		id: str(row.id),
		name: typeof row.name === 'string' ? row.name : '',
		description: str(row.description),
		media,
		pageWidthMm: required('page_width_mm'),
		pageHeightMm: required('page_height_mm'),
		columns: required('columns'),
		rows: required('rows'),
		labelWidthMm: required('label_width_mm'),
		labelHeightMm: required('label_height_mm'),
		marginTopMm: optional('margin_top_mm', 0),
		marginLeftMm: optional('margin_left_mm', 0),
		gapXMm: optional('gap_x_mm', 0),
		gapYMm: optional('gap_y_mm', 0),
		paddingMm: optional('padding_mm', 2),
		arrangement,
		qrSizeMm: row.qr_size_mm === null || row.qr_size_mm === undefined || row.qr_size_mm === '' ? null : num(row.qr_size_mm),
		fields: parseFields(row.fields),
		qrFields: parseQrKeys(row.qr_fields),
		isDefault: row.is_default === true,
		userCreated: str(row.user_created),
		dateCreated: str(row.date_created),
		userUpdated: str(row.user_updated),
		dateUpdated: str(row.date_updated),
	};
	if (t.qrSizeMm === null && row.qr_size_mm !== null && row.qr_size_mm !== undefined && row.qr_size_mm !== '') problems.push('qr_size_mm is not a number');
	if (problems.length) throw new Error(`Invalid label template${t.name ? ` "${t.name}"` : ''}: ${problems.join('; ')}`);
	return t;
}

const positive = (n: number) => Number.isFinite(n) && n > 0;
const nonNegative = (n: number) => Number.isFinite(n) && n >= 0;
const whole = (n: number) => Number.isInteger(n) && n >= 1;
const mm = (n: number) => `${Math.round(n * 100) / 100} mm`;

// Human-readable problems with a template, [] when it is printable. Works on any LabelTemplate, so the
// editor can run it on every keystroke.
export function validateTemplate(t: LabelTemplate): string[] {
	const out: string[] = [];
	if (!t.name.trim()) out.push('Give the template a name.');
	if (!MEDIA.includes(t.media)) out.push('Media must be a sheet or a roll.');
	if (!ARRANGEMENTS.includes(t.arrangement)) out.push('Choose an arrangement.');

	if (!positive(t.pageWidthMm)) out.push('Page width must be more than 0 mm.');
	if (!positive(t.pageHeightMm)) out.push('Page height must be more than 0 mm.');
	if (!positive(t.labelWidthMm)) out.push('Label width must be more than 0 mm.');
	if (!positive(t.labelHeightMm)) out.push('Label height must be more than 0 mm.');
	if (!whole(t.columns)) out.push('Columns must be a whole number, 1 or more.');
	if (!whole(t.rows)) out.push('Rows must be a whole number, 1 or more.');
	if (!nonNegative(t.marginTopMm) || !nonNegative(t.marginLeftMm)) out.push('Margins cannot be negative.');
	if (!nonNegative(t.gapXMm) || !nonNegative(t.gapYMm)) out.push('Gaps cannot be negative.');
	if (!nonNegative(t.paddingMm)) out.push('Padding cannot be negative.');
	if (out.length) return out; // the geometry checks below need sane numbers

	if (t.media === 'roll' && (t.columns !== 1 || t.rows !== 1)) out.push('A roll prints one label per page: use 1 column and 1 row.');

	const gridW = t.marginLeftMm + t.columns * t.labelWidthMm + (t.columns - 1) * t.gapXMm;
	if (gridW > t.pageWidthMm + EPS) out.push(`The labels are wider than the page (${mm(gridW)} of ${mm(t.pageWidthMm)}).`);
	const gridH = t.marginTopMm + t.rows * t.labelHeightMm + (t.rows - 1) * t.gapYMm;
	if (gridH > t.pageHeightMm + EPS) out.push(`The labels are taller than the page (${mm(gridH)} of ${mm(t.pageHeightMm)}).`);

	const innerW = t.labelWidthMm - 2 * t.paddingMm;
	const innerH = t.labelHeightMm - 2 * t.paddingMm;
	if (innerW <= 0 || innerH <= 0) {
		out.push('The padding leaves no room inside the label.');
	} else if (t.qrSizeMm !== null) {
		if (!positive(t.qrSizeMm)) out.push('The QR size must be more than 0 mm (or empty for automatic).');
		else if (t.arrangement !== 'text_only' && (t.qrSizeMm > innerW + EPS || t.qrSizeMm > innerH + EPS)) {
			out.push(`The QR code (${mm(t.qrSizeMm)}) does not fit inside the label's padding (${mm(innerW)} x ${mm(innerH)}).`);
		}
	}
	if (t.arrangement === 'text_only' && t.fields.length === 0) out.push('Add at least one field, or choose an arrangement with a QR code.');
	return out;
}
