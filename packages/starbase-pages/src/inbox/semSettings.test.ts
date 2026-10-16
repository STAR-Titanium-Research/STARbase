// The imaging settings of an SEM image as labelled rows: what the Inbox row and the record page both show (spec 2026-10-16-sem-data-bar-reader-design.md
// section 6). Pure formatting, so every rule here is checked without a page.
import { describe, expect, it } from 'vitest';
import { extractedText } from './inboxModel';
import { FIELDS, editDraft, extractedView, parseEdit, scaleBarText, settingRows, ukLocalToIso, ukTime } from './semSettings';

const FULL = {
	kv: 15, spot: 3, working_distance_mm: 8.5, magnification: 5000, hfw_um: 59.7, pixel_size_nm: 29.14, scale_bar_um: 10, detector: 'ETD', mode: 'SE',
	instrument: 'Quanta 650', acquired_at: '2026-03-02T10:15:30.000Z',
};
const SOURCES = {
	kv: 'metadata', spot: 'metadata', working_distance_mm: 'metadata', magnification: 'derived', hfw_um: 'metadata', pixel_size_nm: 'metadata', scale_bar_um: 'ocr',
	detector: 'metadata', mode: 'metadata', instrument: 'metadata', acquired_at: 'metadata',
};
const rows = (values: Record<string, unknown>, sources: Record<string, unknown> = {}, flags: Record<string, unknown> = {}) => settingRows({ values, sources, flags });
const byKey = (r: ReturnType<typeof settingRows>) => Object.fromEntries(r.map((x) => [x.key, x]));

describe('scaleBarText', () => {
	it('says micrometres, millimetres from 1000 and nanometres under 1', () => {
		expect(scaleBarText(500)).toBe('500 µm');
		expect(scaleBarText(2)).toBe('2 µm');
		expect(scaleBarText(1000)).toBe('1 mm');
		expect(scaleBarText(3000)).toBe('3 mm');
		expect(scaleBarText(1500)).toBe('1.5 mm');
		expect(scaleBarText(0.2)).toBe('200 nm');
		expect(scaleBarText(0.05)).toBe('50 nm');
		expect(scaleBarText(0.999)).toBe('999 nm');
	});
});

describe('ukTime', () => {
	it('shows an instant as UK time with GMT in winter and BST in summer', () => {
		expect(ukTime('2026-03-02T10:15:30.000Z')).toBe('2 Mar 2026, 10:15 GMT');
		expect(ukTime('2026-07-01T09:05:00+00:00')).toBe('1 Jul 2026, 10:05 BST');
		expect(ukTime('2026-07-01T10:05:00+01:00')).toBe('1 Jul 2026, 10:05 BST');
	});
	it('shows what it cannot read as it was sent', () => {
		expect(ukTime('not a date')).toBe('not a date');
	});
});

describe('settingRows', () => {
	it('shows labelled values with units in a fixed order, each with its source', () => {
		const r = rows(FULL, SOURCES);
		expect(r.map((x) => [x.label, x.text, x.source])).toEqual([
			['kV', '15 kV', 'metadata'],
			['working distance', '8.5 mm', 'metadata'],
			['magnification', '×5,000', 'derived'],
			['spot', '3', 'metadata'],
			['detector', 'ETD', 'metadata'],
			['mode', 'SE', 'metadata'],
			['scale bar', '10 µm', 'OCR'],
			['taken', '2 Mar 2026, 10:15 GMT', 'metadata'],
			['field width', '59.7 µm', 'metadata'],
			['pixel size', '29.14 nm', 'metadata'],
			['instrument', 'Quanta 650', 'metadata'],
		]);
	});

	it('marks a manual correction as manual', () => {
		expect(byKey(rows({ kv: 20 }, { kv: 'manual' })).kv.source).toBe('manual');
	});

	it('marks "check this" on values the bar was the only witness for, when flags.check_this is true', () => {
		const r = byKey(rows(FULL, SOURCES, { check_this: true }));
		expect(r.scale_bar_um.check).toBe(true);
		expect(r.kv.check).toBe(false);
		expect(r.magnification.check).toBe(false);
		expect(byKey(rows(FULL, SOURCES, {})).scale_bar_um.check).toBe(false);
		expect(byKey(rows(FULL, SOURCES, { check_this: false })).scale_bar_um.check).toBe(false);
	});

	it('marks every value when check_this is set and nothing says where a value came from', () => {
		const r = byKey(rows({ kv: 15, spot: 3 }, {}, { check_this: true }));
		expect([r.kv.check, r.spot.check]).toEqual([true, true]);
		expect(r.kv.source).toBeNull();
	});

	it('says "couldn\'t read <field>" for a flagged field with no value, and gives the reason', () => {
		const r = rows({ kv: 15 }, { kv: 'ocr' }, { magnification: 'hfw_mismatch', scale_bar_um: 'length_mismatch', acquired_at: 'invalid_local_time', check_this: true });
		const k = byKey(r);
		expect(k.magnification.failed).toBe("couldn't read magnification");
		expect(k.magnification.text).toBeNull();
		expect(k.magnification.reason).toBe('the magnification does not fit the field width');
		expect(k.scale_bar_um.failed).toBe("couldn't read scale bar");
		expect(k.acquired_at.failed).toBe("couldn't read time taken");
		expect(k.acquired_at.reason).toBe('that local time does not exist (the clocks went forward)');
		expect(k.kv.failed).toBeNull();
		expect(r.map((x) => x.key)).toEqual(['kv', 'magnification', 'scale_bar_um', 'acquired_at']);
	});

	it('does not say "couldn\'t read" when the field has a value, and ignores a flag that is not a reason', () => {
		const k = byKey(rows({ kv: 15 }, {}, { kv: 'out_of_range', spot: true, nonsense: 'x' }));
		expect(k.kv.failed).toBeNull();
		expect(k.kv.text).toBe('15 kV');
		expect(k.spot).toBeUndefined();
		expect(k.nonsense).toBeUndefined();
	});

	it('shows nothing extra when there are no keys, and ignores ocr_confidence', () => {
		expect(rows({})).toEqual([]);
		expect(rows({ ocr_confidence: { kv: 0.6 } })).toEqual([]);
		expect(rows({}, { kv: 'ocr' }, { check_this: true })).toEqual([]);
	});

	it('leaves out null, empty and non-numeric values rather than showing them', () => {
		expect(rows({ kv: null, spot: '', magnification: Number.NaN, detector: '  ' })).toEqual([]);
	});

	it('reads the legacy string scale_bar when scale_bar_um is absent, and prefers scale_bar_um when both are there', () => {
		expect(byKey(rows({ scale_bar: '2 µm' })).scale_bar_um.text).toBe('2 µm');
		expect(byKey(rows({ scale_bar: '2 µm', scale_bar_um: 500 })).scale_bar_um.text).toBe('500 µm');
	});
});

describe('extractedView', () => {
	it('takes the values, sources and flags out of a candidate\'s extracted', () => {
		const r = settingRows(extractedView({ kv: 15, sources: { kv: 'ocr' }, flags: { check_this: true }, ocr_confidence: { kv: 0.6 } }));
		expect(r.map((x) => [x.key, x.source, x.check])).toEqual([['kv', 'OCR', true]]);
	});
	it('reads a row with no sources or flags as plain values', () => {
		expect(settingRows(extractedView({ kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' })).map((x) => x.text)).toEqual(['15 kV', '×5,000', '2 µm', 'JEOL']);
	});
	it('survives odd sources and flags', () => {
		expect(settingRows(extractedView({ kv: 15, sources: 'x', flags: [] })).map((x) => x.text)).toEqual(['15 kV']);
	});
});

describe('the one-line summary reads scale_bar_um too', () => {
	it('formats the number and keeps the legacy string', () => {
		expect(extractedText({ kv: 15, magnification: 5000, scale_bar_um: 2, instrument: 'JEOL' })).toBe('15 kV · ×5,000 · 2 µm · JEOL');
		expect(extractedText({ scale_bar_um: 3000 })).toBe('3 mm');
		expect(extractedText({ scale_bar_um: 0.2 })).toBe('200 nm');
		expect(extractedText({ scale_bar: '2 µm' })).toBe('2 µm');
		expect(extractedText({ scale_bar: '2 µm', scale_bar_um: 500 })).toBe('500 µm');
	});
});

describe('editing a value', () => {
	it('offers all eleven settings', () => {
		expect(FIELDS.map((f) => f.key)).toEqual([
			'kv', 'working_distance_mm', 'magnification', 'spot', 'detector', 'mode', 'scale_bar_um', 'acquired_at', 'hfw_um', 'pixel_size_nm', 'instrument',
		]);
	});
	it('turns typed text into the value the endpoint takes', () => {
		expect(parseEdit('kv', '20')).toEqual({ value: 20 });
		expect(parseEdit('kv', ' 7.5 ')).toEqual({ value: 7.5 });
		expect(parseEdit('magnification', '5,000')).toEqual({ value: 5000 });
		expect(parseEdit('detector', ' ETD ')).toEqual({ value: 'ETD' });
		expect(parseEdit('scale_bar_um', '0.2')).toEqual({ value: 0.2 });
	});
	it('refuses what is not a value before asking the server', () => {
		expect(parseEdit('kv', '')).toMatchObject({ error: expect.any(String) });
		expect(parseEdit('kv', 'abc')).toMatchObject({ error: expect.any(String) });
		expect(parseEdit('kv', 'Infinity')).toMatchObject({ error: expect.any(String) });
		expect(parseEdit('magnification', '5000.5')).toMatchObject({ error: expect.any(String) });
		expect(parseEdit('detector', '   ')).toMatchObject({ error: expect.any(String) });
		expect(parseEdit('read_by', '1')).toMatchObject({ error: expect.any(String) });
	});
	it('reads a time typed as UK local time and sends it with its offset', () => {
		expect(parseEdit('acquired_at', '2026-03-02T10:15')).toEqual({ value: '2026-03-02T10:15:00+00:00' });
		expect(parseEdit('acquired_at', '2026-07-01T10:05')).toEqual({ value: '2026-07-01T10:05:00+01:00' });
		expect(parseEdit('acquired_at', '')).toMatchObject({ error: expect.any(String) });
		expect(parseEdit('acquired_at', 'yesterday')).toMatchObject({ error: expect.any(String) });
	});
	it('takes the first of the repeated autumn hour and refuses the skipped spring hour', () => {
		expect(ukLocalToIso('2026-10-25T01:30')).toBe('2026-10-25T01:30:00+01:00');
		expect(ukLocalToIso('2026-03-29T01:30')).toBeNull();
		expect(ukLocalToIso('2026-03-29T02:30')).toBe('2026-03-29T02:30:00+01:00');
		expect(ukLocalToIso('2026-02-30T10:00')).toBeNull();
	});
});

describe('rows for the owner, who may fill in any setting', () => {
	it('with all: true every setting has a row, the ones with no value as "not set"', () => {
		const r = settingRows({ values: { kv: 15 }, sources: { kv: 'ocr' }, flags: { magnification: 'hfw_mismatch' } }, { all: true });
		expect(r.map((x) => x.key)).toEqual(FIELDS.map((f) => f.key));
		const k = byKey(r);
		expect(k.kv.text).toBe('15 kV');
		expect(k.magnification.failed).toBe("couldn't read magnification");
		expect(k.spot).toMatchObject({ text: null, failed: null, source: null, check: false });
	});
});

describe('the text an edit box starts with', () => {
	it('is the value as typed back, the time in UK local form, and empty for a setting with none', () => {
		expect(editDraft('kv', { kv: 15 })).toBe('15');
		expect(editDraft('magnification', { magnification: 5000 })).toBe('5000');
		expect(editDraft('detector', { detector: 'ETD' })).toBe('ETD');
		expect(editDraft('acquired_at', { acquired_at: '2026-07-01T09:05:00+00:00' })).toBe('2026-07-01T10:05');
		expect(editDraft('acquired_at', { acquired_at: '2026-03-02T10:15:30.000Z' })).toBe('2026-03-02T10:15');
		expect(editDraft('spot', {})).toBe('');
		expect(editDraft('acquired_at', { acquired_at: 'nope' })).toBe('');
	});
	it('reads back through parseEdit to the same value', () => {
		expect(parseEdit('acquired_at', editDraft('acquired_at', { acquired_at: '2026-07-01T09:05:00+00:00' }))).toEqual({ value: '2026-07-01T10:05:00+01:00' });
	});
});
