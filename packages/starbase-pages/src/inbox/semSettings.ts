// The imaging settings of an SEM image as labelled rows (spec 2026-10-16-sem-data-bar-reader-design.md section 6): what the Inbox row shows from a
// candidate's `extracted`, and what the record page shows from d1-inbox's /sem-settings answer. Pure formatting; the pages only draw the rows.
//
// The data (spec section 2): numeric values with the unit in the key (`kv`, `working_distance_mm`, `scale_bar_um`, ...), absent when unknown and never
// null; `sources` (field -> metadata | derived | ocr | manual); `flags` (field -> a reason when the value could not be kept, plus the boolean
// `check_this` when something was read and no cross-check could vouch for it). `ocr_confidence` is recorded by the crawler and never shown: it is
// not a threshold.

export type SemFieldType = 'number' | 'integer' | 'text' | 'time';

export interface SemField {
	key: string;
	/** The row's label. */
	label: string;
	/** What "couldn't read ..." calls the field. */
	noun: string;
	/** The unit an edit box takes (the unit in the key), '' for none. */
	unit: string;
	type: SemFieldType;
}

/** Every setting in the order they are shown: the first eight are the ones a person reads first, the rest follow. */
const FIELDS: readonly SemField[] = [
	{ key: 'kv', label: 'kV', noun: 'kV', unit: 'kV', type: 'number' },
	{ key: 'working_distance_mm', label: 'working distance', noun: 'working distance', unit: 'mm', type: 'number' },
	{ key: 'magnification', label: 'magnification', noun: 'magnification', unit: '×', type: 'integer' },
	{ key: 'spot', label: 'spot', noun: 'spot', unit: '', type: 'number' },
	{ key: 'detector', label: 'detector', noun: 'detector', unit: '', type: 'text' },
	{ key: 'mode', label: 'mode', noun: 'mode', unit: '', type: 'text' },
	{ key: 'scale_bar_um', label: 'scale bar', noun: 'scale bar', unit: 'µm', type: 'number' },
	{ key: 'acquired_at', label: 'taken', noun: 'time taken', unit: 'UK time', type: 'time' },
	{ key: 'hfw_um', label: 'field width', noun: 'field width', unit: 'µm', type: 'number' },
	{ key: 'pixel_size_nm', label: 'pixel size', noun: 'pixel size', unit: 'nm', type: 'number' },
	{ key: 'instrument', label: 'instrument', noun: 'instrument', unit: '', type: 'text' },
];
const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** The settings a person can correct (all of them), in display order. */
export const editableFields = (): readonly SemField[] => FIELDS;
export const fieldOf = (key: string): SemField | undefined => FIELD_BY_KEY.get(key);

const SOURCE_LABEL: Record<string, string> = { metadata: 'metadata', derived: 'derived', ocr: 'OCR', manual: 'manual' };
/** Sources that checked the value themselves: no "check this" mark on them. */
const SELF_CHECKED = new Set(['metadata', 'derived', 'manual']);

/** Why a value could not be kept, in words (the crawler's flag reasons); a reason this does not know is shown as it was sent. */
const REASON_TEXT: Record<string, string> = {
	hfw_mismatch: 'the magnification does not fit the field width',
	length_mismatch: 'the scale bar label does not match the bar',
	out_of_range: 'the value was outside the possible range',
	no_hfw: 'there is no field width to check it against',
	invalid_local_time: 'that local time does not exist (the clocks went forward)',
	not_a_number: 'it was not a number',
	unparseable: 'it could not be read as text',
};

export interface SettingRow {
	key: string;
	label: string;
	/** The formatted value with its unit, or null when the field has none ("couldn't read ..."). */
	text: string | null;
	/** Where the value came from, as a label ('metadata', 'derived', 'OCR', 'manual'); null when nothing says. */
	source: string | null;
	/** The "check this" mark: nothing could vouch for this value. */
	check: boolean;
	/** "couldn't read <field>" for a flagged field with no value. */
	failed: string | null;
	/** Why, in words, for a failed field. */
	reason: string | null;
}

export interface SettingsView {
	values: Record<string, unknown>;
	sources: Record<string, unknown>;
	flags: Record<string, unknown>;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A candidate's `extracted` as a view: the object is the values, with its own `sources` and `flags` (a row from before them has neither). */
export function extractedView(extracted: Record<string, unknown> | null | undefined): SettingsView {
	const e = isObject(extracted) ? extracted : {};
	return { values: e, sources: isObject(e.sources) ? e.sources : {}, flags: isObject(e.flags) ? e.flags : {} };
}

// ---- formatting ----

const GB = 'en-GB';
/** A number without float noise or trailing zeros: 29.14, 8.5, 5,000. */
const plain = (n: number): string => Number(n.toPrecision(10)).toLocaleString(GB, { maximumFractionDigits: 6 });

/** The scale bar's length: micrometres, millimetres from 1000, nanometres under 1 ("500 µm", "3 mm", "200 nm"). */
export function scaleBarText(um: number): string {
	if (um >= 1000) return `${plain(um / 1000)} mm`;
	if (um < 1) return `${plain(um * 1000)} nm`;
	return `${plain(um)} µm`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

const UK_TIME = new Intl.DateTimeFormat(GB, { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
/** An ISO 8601 instant as UK time with its zone, "2 Mar 2026, 10:15 GMT" (BST in summer). What cannot be read as a date is returned as it was. */
export function ukTime(iso: string): string {
	const t = new Date(iso);
	if (Number.isNaN(t.getTime())) return iso;
	const p = Object.fromEntries(UK_TIME.formatToParts(t).map((x) => [x.type, x.value]));
	return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** One value as text, or null when there is nothing to show (absent, null, empty, NaN). */
function valueText(key: string, values: Record<string, unknown>): string | null {
	const v = values[key];
	switch (key) {
		case 'kv': {
			const kv = v ?? values.kV;
			return finite(kv) ? `${plain(kv)} kV` : text(kv) ? `${text(kv)} kV` : null;
		}
		case 'working_distance_mm':
			return finite(v) ? `${plain(v)} mm` : null;
		case 'magnification': {
			if (finite(v)) return `×${v.toLocaleString(GB)}`;
			const m = text(v);
			return m ? (m.startsWith('×') || m.toLowerCase().startsWith('x') ? m : `×${m}`) : null;
		}
		case 'spot':
			return finite(v) ? plain(v) : null;
		case 'scale_bar_um':
			if (finite(v)) return scaleBarText(v);
			// a candidate stored before the crawler read micrometres carries the label as text
			return text(values.scale_bar);
		case 'acquired_at':
			return text(v) ? ukTime(text(v)!) : null;
		case 'hfw_um':
			return finite(v) ? `${plain(v)} µm` : null;
		case 'pixel_size_nm':
			return finite(v) ? `${plain(v)} nm` : null;
		default:
			return text(v);
	}
}

/**
 * The rows to show, in a fixed order: a value with its unit and source; a field with a flag and no value as "couldn't read <field>"; nothing for a
 * field with neither. A value gets the "check this" mark when `flags.check_this` is true and no source vouched for it (OCR, or nothing says).
 */
export function settingRows(view: SettingsView): SettingRow[] {
	const out: SettingRow[] = [];
	const checkAll = view.flags.check_this === true;
	for (const f of FIELDS) {
		const t = valueText(f.key, view.values);
		const src = typeof view.sources[f.key] === 'string' ? (view.sources[f.key] as string) : null;
		const source = src ? (SOURCE_LABEL[src] ?? src) : null;
		if (t !== null) {
			out.push({ key: f.key, label: f.label, text: t, source, check: checkAll && !(src && SELF_CHECKED.has(src)), failed: null, reason: null });
			continue;
		}
		const why = view.flags[f.key];
		if (typeof why === 'string' && why !== '') {
			out.push({ key: f.key, label: f.label, text: null, source: null, check: false, failed: `couldn't read ${f.noun}`, reason: REASON_TEXT[why] ?? why });
		}
	}
	return out;
}

// ---- correcting a value ----

const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const ukFields = (ms: number): string => {
	const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
};

/**
 * A time typed as UK local time ("2026-03-02T10:15", what a datetime-local box gives) as ISO 8601 with its offset. The repeated autumn hour takes
 * the first occurrence (BST), as the crawler does (D5); a time that does not exist (the skipped spring hour, 30 February) is null.
 */
export function ukLocalToIso(local: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
	if (!m) return null;
	const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
	const s = m[6] ? Number(m[6]) : 0;
	const wanted = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(s).padStart(2, '0')}`;
	const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
	for (const offset of [60, 0]) {
		if (ukFields(asUtc - offset * 60_000) === wanted) return `${wanted}${offset === 60 ? '+01:00' : '+00:00'}`;
	}
	return null;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const GROUPED = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/;

/** What a person typed into a field's edit box as the value to send, or the reason it cannot be sent (the server decides the ranges). */
export function parseEdit(key: string, typed: string): { value: number | string } | { error: string } {
	const f = FIELD_BY_KEY.get(key);
	if (!f) return { error: 'That is not a setting that can be corrected.' };
	const raw = typed.trim();
	if (raw === '') return { error: `Enter the ${f.noun}.` };
	if (f.type === 'time') {
		const iso = ukLocalToIso(raw);
		return iso ? { value: iso } : { error: 'Enter a time that exists in UK time, for example 2026-03-02 10:15.' };
	}
	if (f.type === 'text') return raw.length > 200 ? { error: `The ${f.noun} is too long (at most 200 characters).` } : { value: raw };
	const n = GROUPED.test(raw) ? Number(raw.replace(/,/g, '')) : NUMBER.test(raw) ? Number(raw) : Number.NaN;
	if (!Number.isFinite(n)) return { error: `Enter the ${f.noun} as a number.` };
	if (f.type === 'integer' && !Number.isInteger(n)) return { error: `Enter the ${f.noun} as a whole number.` };
	return { value: n };
}
