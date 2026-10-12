import { describe, expect, it } from 'vitest';
import {
	LABEL_SAMPLE_FIELDS, MAX_COPIES, MEMBER_COLUMNS, blankTemplate, canEditTemplate, classifyTemplates, clampCopies, clampStart, copyAsNew,
	countLabels, moveField, parseCodes, parseSelectionQuery, pickTemplate, pickerFilter, saveErrorText, slotsPerPage, summaryText, templatePayload,
} from './page';
import { templateFromRow } from './template';
import { toLabelSample, isPrintableSample } from './sample';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const row = (over: Record<string, unknown> = {}) => ({
	id: 'a', name: 'A4 4×5', media: 'sheet', page_width_mm: '210', page_height_mm: '297', columns: 4, rows: 5,
	label_width_mm: '52.5', label_height_mm: '59.4', arrangement: 'qr_top', is_default: false, user_created: null,
	fields: [{ key: 'sample_code', size: 'lg', bold: true }], ...over,
});

describe('parseSelectionQuery', () => {
	it('reads comma lists and repeated params, lower-cases ids, drops duplicates and non-uuids', () => {
		expect(parseSelectionQuery({ ids: `${ID1},${ID2.toUpperCase()},${ID1},nope` }).ids).toEqual([ID1, ID2]);
		expect(parseSelectionQuery({ ids: [ID1, `${ID2}`] }).ids).toEqual([ID1, ID2]);
	});
	it('reads codes and tolerates missing or odd values', () => {
		expect(parseSelectionQuery({ codes: 'S-1, S-2 ,S-1' }).codes).toEqual(['S-1', 'S-2']);
		expect(parseSelectionQuery({})).toEqual({ ids: [], codes: [] });
		expect(parseSelectionQuery({ ids: null, codes: 3 })).toEqual({ ids: [], codes: [] });
	});
});

describe('parseCodes', () => {
	it('splits on lines, commas, semicolons and tabs, keeps inner spaces, trims and de-duplicates', () => {
		expect(parseCodes('S-1\r\nS-2, S-3;S 4\t S-1\n\n')).toEqual(['S-1', 'S-2', 'S-3', 'S 4']);
		expect(parseCodes('  ')).toEqual([]);
	});
});

describe('pickerFilter', () => {
	it('is empty with nothing chosen', () => {
		expect(pickerFilter({ search: ' ', campaignId: '', projectScope: null })).toEqual({});
	});
	it('ANDs the search, the project rule and the campaign junction', () => {
		const scope = { project_id: { _eq: 'p' } };
		const f = pickerFilter({ search: 'ti', campaignId: 'c', projectScope: scope }) as { _and: unknown[] };
		expect(f._and).toHaveLength(3);
		expect(f._and[0]).toEqual({ _or: [{ sample_code: { _icontains: 'ti' } }, { nickname: { _icontains: 'ti' } }, { short_id: { _icontains: 'ti' } }] });
		expect(f._and[1]).toBe(scope);
		expect(f._and[2]).toEqual({ campaigns: { _some: { campaign_id: { _eq: 'c' } } } });
	});
});

describe('clamps', () => {
	it('keeps start at 1..slots', () => {
		expect(clampStart(0, 20)).toBe(1);
		expect(clampStart(25, 20)).toBe(20);
		expect(clampStart(7.9, 20)).toBe(7);
		expect(clampStart('', 20)).toBe(1);
		expect(clampStart('abc', 20)).toBe(1);
		expect(clampStart(5, 1)).toBe(1);
	});
	it('keeps copies at 1..MAX_COPIES', () => {
		expect(clampCopies(0)).toBe(1);
		expect(clampCopies('3')).toBe(3);
		expect(clampCopies(10 ** 6)).toBe(MAX_COPIES);
		expect(clampCopies(NaN)).toBe(1);
	});
	it('counts slots: a roll is one whatever its grid says', () => {
		expect(slotsPerPage({ media: 'sheet', columns: 4, rows: 5 })).toBe(20);
		expect(slotsPerPage({ media: 'roll', columns: 1, rows: 1 })).toBe(1);
	});
});

describe('summary', () => {
	const mk = (code: string, shortId: string) => toLabelSample({ sample_id: `${ID1}`, sample_code: code, short_id: shortId });
	it('counts only printable labels', () => {
		const pages = [[mk('S-1', '1a2b3c4d'), null, mk('', '1a2b3c4d')], [mk('S-2', '1a2b3c4d')]];
		expect(countLabels(pages, isPrintableSample)).toBe(2);
	});
	it('reads as the page shows it', () => {
		expect(summaryText({ labels: 12, pages: 1, clipped: 1, invalid: 2 })).toBe('12 labels on 1 page · 1 clipped · 2 skipped (invalid)');
		expect(summaryText({ labels: 1, pages: 2, clipped: 0, invalid: 0 })).toBe('1 label on 2 pages · 0 clipped · 0 skipped (invalid)');
	});
});

describe('classifyTemplates and pickTemplate', () => {
	it('keeps the good rows and names why a corrupt one is broken', () => {
		const { templates, broken } = classifyTemplates([row(), row({ id: 'z', name: 'Bad', page_width_mm: 'wide' })]);
		expect(templates.map((t) => t.id)).toEqual(['a']);
		expect(broken).toEqual([{ id: 'z', name: 'Bad', reason: 'page_width_mm is not a number' }]);
	});
	const a = templateFromRow(row({ id: 'a', name: 'A' }));
	const b = templateFromRow(row({ id: 'b', name: 'B', is_default: true }));
	const c = templateFromRow(row({ id: 'c', name: 'C', page_width_mm: 10 })); // labels wider than the page
	it('prefers the remembered template, then the default, then the first that prints', () => {
		expect(pickTemplate([a, b], 'a')?.id).toBe('a');
		expect(pickTemplate([a, b], null)?.id).toBe('b');
		expect(pickTemplate([a, b], 'gone')?.id).toBe('b');
		expect(pickTemplate([a, templateFromRow(row({ id: 'q', name: 'Q' }))], null)?.id).toBe('a');
	});
	it('never chooses a template with problems, and returns null when none prints', () => {
		expect(pickTemplate([c, a], 'c')?.id).toBe('a');
		expect(pickTemplate([c], null)).toBeNull();
		expect(pickTemplate([], null)).toBeNull();
	});
});

describe('canEditTemplate', () => {
	const mine = { id: 't', userCreated: 'u1' };
	it('allows the owner and an admin only', () => {
		expect(canEditTemplate(mine, 'u1', false)).toBe(true);
		expect(canEditTemplate(mine, 'u2', false)).toBe(false);
		expect(canEditTemplate(mine, 'u2', true)).toBe(true);
		expect(canEditTemplate({ id: 't', userCreated: null }, 'u1', false)).toBe(false); // a seed
	});
	it('offers nothing while the user is unknown, or for an unsaved draft', () => {
		expect(canEditTemplate(mine, null, false)).toBe(false);
		expect(canEditTemplate({ id: null, userCreated: null }, 'u1', true)).toBe(false);
	});
});

describe('templatePayload', () => {
	const t = { ...blankTemplate(), name: ' Mine ', description: '  ', qrSizeMm: '' as unknown as number, isDefault: true };
	it('sends exactly the 18 content columns to a member', () => {
		const body = templatePayload(t, false);
		expect(Object.keys(body).sort()).toEqual([...MEMBER_COLUMNS].sort());
		expect(MEMBER_COLUMNS).toHaveLength(18);
		expect(body).toMatchObject({ name: 'Mine', description: null, qr_size_mm: null, columns: 4, margin_top_mm: 0 });
	});
	it('adds is_default for an admin only', () => {
		expect(templatePayload(t, true).is_default).toBe(true);
		expect('is_default' in templatePayload(t, false)).toBe(false);
	});
	it('drops duplicate QR fields and unknown bold values', () => {
		const body = templatePayload({ ...t, qrFields: ['material', 'material', 'date'], fields: [{ key: 'sample_code', size: 'lg', bold: undefined as unknown as boolean }] }, false);
		expect(body.qr_fields).toEqual(['material', 'date']);
		expect(body.fields).toEqual([{ key: 'sample_code', size: 'lg', bold: false }]);
	});
});

describe('draft helpers', () => {
	it('copies a template as a new, non-default row', () => {
		const src = { ...templateFromRow(row({ is_default: true, user_created: 'u1' })) };
		const c = copyAsNew(src);
		expect(c).toMatchObject({ id: null, name: 'A4 4×5 copy', isDefault: false, userCreated: null });
		c.fields[0].size = 'sm';
		expect(src.fields[0].size).toBe('lg'); // a deep copy
	});
	it('moves fields and ignores bad indexes', () => {
		const f = [{ key: 'sample_code', size: 'lg', bold: true }, { key: 'nickname', size: 'sm', bold: false }, { key: 'date', size: 'sm', bold: false }] as const;
		expect(moveField([...f], 0, 2).map((x) => x.key)).toEqual(['nickname', 'date', 'sample_code']);
		expect(moveField([...f], 1, 1)).toEqual([...f]);
		expect(moveField([...f], 0, 9)).toEqual([...f]);
	});
	it('explains a duplicate name', () => {
		expect(saveErrorText('Field "name" has to be unique.')).toMatch(/already exists/);
		expect(saveErrorText('Something else')).toBe('Something else');
	});
});

describe('sample fields', () => {
	it('are the ones toLabelSample reads', () => {
		expect(LABEL_SAMPLE_FIELDS).toContain('owner_person_id.full_name');
		expect(LABEL_SAMPLE_FIELDS).toContain('material_id.alloy_code');
	});
});
