import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FILTERS, DOCUMENT_NOTICE, PAGE_SIZE, STRENGTH_LABEL, TABS,
	canChange, duplicateText, extractedText, filtersToQuery,
	folderOf, hasActiveFilters, hasThumbnail, kindLabel, linkTarget, listPlan, nameOf, needsReadNotice, ownerText, parseFilters,
	primaryAction, sizeText, suggestionOf, whereInPath,
} from './inboxModel';
import { exactMatch, foundFile } from './fakeInboxServer';

describe('tabs', () => {
	it('are New, Older files, Recently linked and Dismissed, in that order', () => {
		expect(TABS.map((t) => [t.id, t.label])).toEqual([
			['new', 'New'], ['older', 'Older files'], ['linked', 'Recently linked'], ['dismissed', 'Dismissed'],
		]);
	});
});

describe('filters in the URL', () => {
	it('the default view has an empty query and parses back to the defaults', () => {
		expect(filtersToQuery(DEFAULT_FILTERS)).toEqual({});
		expect(parseFilters({})).toEqual(DEFAULT_FILTERS);
	});
	it('round-trips every filter', () => {
		const f = { tab: 'older', kind: 'sem_image', folder: 'sem', from: '2026-10-01', to: '2026-10-15', owner: 'team:11111111-2222-4333-8444-555555555555', strength: 'short_id' } as const;
		const q = filtersToQuery(f);
		expect(q).toEqual({ tab: 'older', kind: 'sem_image', folder: 'sem', from: '2026-10-01', to: '2026-10-15', owner: f.owner, strength: 'short_id' });
		expect(parseFilters(q)).toEqual(f);
	});
	it('drops what it does not know: a bad tab, kind, strength, date or owner', () => {
		expect(parseFilters({ tab: 'nope', kind: 'video', strength: 'maybe', from: '15/10/2026', to: '2026-13-45', owner: 'everyone' })).toEqual(DEFAULT_FILTERS);
	});
	it('takes the first of a repeated key and trims the folder text', () => {
		expect(parseFilters({ tab: ['linked', 'new'], folder: '  sem  ' })).toMatchObject({ tab: 'linked', folder: 'sem' });
	});
	it('says whether any filter other than the tab is set', () => {
		expect(hasActiveFilters(parseFilters({ tab: 'linked' }))).toBe(false);
		expect(hasActiveFilters(parseFilters({ folder: 'x' }))).toBe(true);
		expect(hasActiveFilters(parseFilters({ owner: 'me' }))).toBe(true);
	});
});

describe('listPlan', () => {
	it('asks for the picture kinds as rows and the documents as the Other files section', () => {
		const p = listPlan(DEFAULT_FILTERS);
		expect(p.main).toEqual({ tab: 'new', limit: PAGE_SIZE, offset: 0, kind: 'sem_image,surface_scan,image' });
		expect(p.other).toEqual({ tab: 'new', limit: PAGE_SIZE, offset: 0, kind: 'document,other' });
		expect(p.openOther).toBe(false);
	});
	it('a picture kind filter leaves Other files out, and a document filter leaves the rows out and opens the section', () => {
		const img = listPlan({ ...DEFAULT_FILTERS, kind: 'sem_image' });
		expect(img.main?.kind).toBe('sem_image');
		expect(img.other).toBeNull();
		const doc = listPlan({ ...DEFAULT_FILTERS, kind: 'document' });
		expect(doc.main).toBeNull();
		expect(doc.other?.kind).toBe('document');
		expect(doc.openOther).toBe(true);
	});
	it('sends only the filters that are set, and pages by offset', () => {
		const p = listPlan({ ...DEFAULT_FILTERS, tab: 'older', folder: 'sem', from: '2026-10-01', owner: 'me', strength: 'short_id' }, 2);
		expect(p.main).toMatchObject({ tab: 'older', folder: 'sem', from: '2026-10-01', owner: 'me', strength: 'short_id', offset: 2 * PAGE_SIZE });
		expect(p.main).not.toHaveProperty('to');
	});
});

describe('how a file reads', () => {
	it('splits a path and sizes a file', () => {
		expect(nameOf('Users/ab1cd/sem/x.tif')).toBe('x.tif');
		expect(folderOf('Users/ab1cd/sem/x.tif')).toBe('Users/ab1cd/sem');
		expect(folderOf('x.tif')).toBe('');
		expect(sizeText(512)).toBe('512 B');
		expect(sizeText(1536)).toBe('1.5 KB');
		expect(sizeText(2_500_000)).toBe('2.4 MB');
		expect(sizeText(null)).toBe('');
	});
	it('words the kinds, with the SEM tag as a guess', () => {
		expect(kindLabel('sem_image')).toBe('Possible SEM image');
		expect(kindLabel('surface_scan')).toBe('Surface scan');
		expect(kindLabel('document')).toBe('Document');
		expect(kindLabel('other')).toBe('File');
	});
	it('has no thumbnail for any kind in v1 (Directus cannot serve a pointer row): the kind icon only', () => {
		expect([hasThumbnail('sem_image'), hasThumbnail('image'), hasThumbnail('surface_scan'), hasThumbnail('document'), hasThumbnail('other')]).toEqual([false, false, false, false, false]);
	});
	it('shows only what the crawler read from an SEM image', () => {
		expect(extractedText({ kv: 15, magnification: 5000, scale_bar: '2 µm', instrument: 'JEOL' })).toBe('15 kV · ×5,000 · 2 µm · JEOL');
		expect(extractedText({ magnification: '×200' })).toBe('×200');
		expect(extractedText({})).toBe('');
	});
	it('names a team folder as one, and a copy as a copy', () => {
		expect(ownerText({ owner: { kind: 'team', id: 't', name: 'Additive' } })).toBe('Additive (team folder)');
		expect(ownerText({ owner: { kind: 'person', id: 'p', name: 'Ann' } })).toBe('Ann');
		expect(duplicateText({ duplicate_of: null })).toBeNull();
		expect(duplicateText({ duplicate_of: 'x' })).toBe('Copy of another found file');
		expect(duplicateText({ duplicate_of: 'x', duplicate_of_owner: 'Bo' })).toBe("Copy of a file in Bo's Inbox");
	});
});

describe('suggestionOf', () => {
	it('a short ID in the file name reads "short ID `3fa9c1d2` in the file name"', () => {
		const s = suggestionOf(exactMatch());
		expect(s?.text).toBe('short ID `3fa9c1d2` in the file name');
		expect(s?.record).toBe('S-0042');
		expect(s?.weak).toBe(false);
		expect(s?.target?.collection).toBe('physical_samples');
	});
	it('says folder name when only a folder carries the token, and path when it is not found as written', () => {
		expect(whereInPath('Users/a/3fa9c1d2/x.tif', '3FA9C1D2')).toBe('folder name');
		expect(whereInPath('Users/a/x.tif', '3fa9c1d2')).toBe('path');
		expect(whereInPath('Users/a/3FA9C1D2_x.tif', '3fa9c1d2')).toBe('file name');
	});
	it('a record code names the kind of code, and an insert edge code is weaker', () => {
		const code = exactMatch({ match_strength: 'code', matches: [{ collection: 'physical_samples', record_id: 'r', via: 'code', token: 'TI-014' }], suggested_record_id: 'r', rel_path: 'Users/a/TI-014_x.tif' });
		expect(suggestionOf(code)?.text).toBe('sample code `TI-014` in the file name');
		const edge = foundFile({
			match_strength: 'edge_code', rel_path: 'Users/a/H13A-#2-fC.al3d', suggested_collection: 'insert_edges', suggested_record_id: 'e1',
			matches: [{ collection: 'insert_edges', record_id: 'e1', via: 'edge_code', token: 'H13A-#2-fC' }],
		});
		const s = suggestionOf(edge);
		expect(s?.text).toBe('insert edge code `H13A-#2-fC` in the file name');
		expect(s?.weak).toBe(true);
		expect(s?.target).toBeNull();
	});
	it('two records sharing a token, or no match, is never flagged', () => {
		const two = foundFile({
			match_strength: 'short_id',
			matches: [{ collection: 'physical_samples', record_id: 'a', via: 'short_id', token: '3fa9c1d2' }, { collection: 'physical_samples', record_id: 'b', via: 'short_id', token: '3fa9c1d2' }],
		});
		expect(suggestionOf(two)).toBeNull();
		expect(suggestionOf(foundFile())).toBeNull();
	});
	it('falls back to the kind of record when the server did not resolve its label', () => {
		expect(suggestionOf(exactMatch({ suggested_label: null }))?.record).toBe('a sample');
	});
	it('names the match strengths', () => {
		expect(STRENGTH_LABEL).toEqual({ short_id: 'Exact short ID', code: 'Record code', edge_code: 'Insert edge code (weaker)', none: 'No match' });
	});
});

describe('the row buttons', () => {
	it('a file with a linkable suggestion links straight to it and can be changed', () => {
		const f = exactMatch();
		expect(primaryAction(f)).toEqual({ kind: 'link', label: 'Link' });
		expect(canChange(f)).toBe(true);
	});
	it('a file with no suggestion opens the picker', () => {
		const f = foundFile();
		expect(primaryAction(f)).toEqual({ kind: 'pick', label: 'Link to…' });
		expect(canChange(f)).toBe(false);
	});
	it('a suggestion the caller may not edit opens the picker instead of a link that would be refused', () => {
		expect(primaryAction(exactMatch({ suggested_can_edit: false })).kind).toBe('pick');
	});
	it('a surface scan has its own enabled button, which is not Link, and no Change', () => {
		const f = exactMatch({ kind: 'surface_scan' });
		expect(primaryAction(f)).toEqual({ kind: 'scan', label: 'Add a surface scan' });
		expect(canChange(f)).toBe(false);
	});
	it('only documents and other files need the "reads this file once" notice', () => {
		expect(needsReadNotice('document')).toBe(true);
		expect(needsReadNotice('other')).toBe(true);
		expect(needsReadNotice('sem_image')).toBe(false);
		expect(DOCUMENT_NOTICE).toBe('Linking reads this file once to fingerprint it.');
	});
	it('knows the three link targets', () => {
		expect(['physical_samples', 'manufacturing_operations', 'test_sessions'].map((c) => linkTarget(c)?.noun)).toEqual(['sample', 'operation', 'test']);
		expect(linkTarget('insert_edges')).toBeNull();
	});
});
