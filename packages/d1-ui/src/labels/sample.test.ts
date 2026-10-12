import { describe, expect, it } from 'vitest';
import { initials, isPrintableSample, labelDate, toLabelSample } from './sample';

describe('initials', () => {
	it('takes the first and last word', () => {
		expect(initials('Ada Lovelace')).toBe('AL');
		expect(initials('Ada Augusta King Lovelace')).toBe('AL');
		expect(initials('ada')).toBe('A');
	});
	it('is empty for nothing readable', () => {
		expect(initials('')).toBe('');
		expect(initials(null)).toBe('');
		expect(initials('   ')).toBe('');
	});
});

describe('labelDate', () => {
	it('keeps a DATE string as is', () => {
		expect(labelDate('2026-10-01', '2020-01-01T00:00:00Z')).toBe('2026-10-01');
	});
	it('falls back to the created timestamp, read in London time', () => {
		// 23:30 UTC on 30 Jun is 00:30 BST on 1 Jul
		expect(labelDate(null, '2026-06-30T23:30:00Z')).toBe('2026-07-01');
		expect(labelDate(null, '2026-01-30T23:30:00Z')).toBe('2026-01-30');
	});
	it('is empty when absent or invalid', () => {
		expect(labelDate(null, null)).toBe('');
		expect(labelDate('nonsense', null)).toBe('');
	});
});

describe('toLabelSample', () => {
	const row = {
		sample_id: '1A2B3C4D-0000-4000-8000-000000000001',
		sample_code: 'S-0123',
		short_id: '1a2b3c4d',
		nickname: ' bracket A ',
		material_id: { common_name: 'Ti-6Al-4V', alloy_code: 'T64' },
		manufactured_date: '2026-10-01',
		created_at: '2026-10-05T10:00:00Z',
		owner_person_id: { full_name: 'Dennis Premoli' },
	};
	it('maps a row as the page reads it', () => {
		expect(toLabelSample(row)).toEqual({
			id: '1a2b3c4d-0000-4000-8000-000000000001',
			code: 'S-0123',
			shortId: '1a2b3c4d',
			nickname: 'bracket A',
			material: 'Ti-6Al-4V',
			date: '2026-10-01',
			ownerInitials: 'DP',
		});
	});
	it('uses the alloy code when there is no common name, and tolerates missing relations', () => {
		const s = toLabelSample({ ...row, material_id: { alloy_code: 'T64' }, owner_person_id: null, nickname: '' });
		expect(s.material).toBe('T64');
		expect(s.ownerInitials).toBeNull();
		expect(s.nickname).toBeNull();
	});
	it('accepts flat material / owner_initials values and an unexpanded relation key', () => {
		const s = toLabelSample({ ...row, material_id: 'some-uuid', material: 'Flat', owner_person_id: 'uuid', owner_initials: 'xy' });
		expect(s.material).toBe('Flat');
		expect(s.ownerInitials).toBe('XY');
	});
	it('derives the short id from the uuid when the row lacks one', () => {
		expect(toLabelSample({ ...row, short_id: undefined }).shortId).toBe('1a2b3c4d');
	});
	it('falls back to the created date', () => {
		expect(toLabelSample({ ...row, manufactured_date: null }).date).toBe('2026-10-05');
		expect(toLabelSample({ ...row, manufactured_date: null, created_at: null }).date).toBeNull();
	});
});

describe('isPrintableSample', () => {
	const ok = { id: 'u', code: 'S-1', shortId: '1a2b3c4d', nickname: null, material: null, date: null, ownerInitials: null };
	it('needs a code and a hex short id', () => {
		expect(isPrintableSample(ok)).toBe(true);
		expect(isPrintableSample({ ...ok, code: '' })).toBe(false);
		expect(isPrintableSample({ ...ok, code: '  ' })).toBe(false);
		expect(isPrintableSample({ ...ok, shortId: '' })).toBe(false);
		expect(isPrintableSample({ ...ok, shortId: '1A2B3C4D' })).toBe(false);
		expect(isPrintableSample({ ...ok, shortId: '1a2b3c4' })).toBe(false);
		expect(isPrintableSample({ ...ok, shortId: '1a2b3c4d'.repeat(5) })).toBe(false);
	});
	it('is false for a row that toLabelSample could not fill', () => {
		expect(isPrintableSample(toLabelSample({ sample_id: 'x' }))).toBe(false);
		expect(isPrintableSample(toLabelSample({ sample_id: '1a2b3c4d-0000-4000-8000-000000000001', sample_code: 'S-1' }))).toBe(true);
	});
});
