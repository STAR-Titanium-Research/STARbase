import { describe, expect, it } from 'vitest';
import {
	emptyForm, fileFilter, formatBytes, formProblems, normaliseFile, operationFilter, todayIso, TOPOGRAPHY_EXTENSIONS, VISIBILITY_WARNING, type ScanForm,
} from './addScanModel';

const FILE = { id: 'f1', name: 'edge-A.al3d', path: null, size: 10 };
const ok = (o: Partial<ScanForm> = {}): ScanForm => ({ ...emptyForm(), file: FILE, condition: 'new', ...o });
const TODAY = '2026-10-15';

describe('fileFilter', () => {
	it('offers archive files only (storage star: the worker reads them by archive_path)', () => {
		const f = fileFilter('') as any;
		expect(f._and[0]).toEqual({ storage: { _eq: 'star' } });
		expect(f._and).toHaveLength(2);
	});
	it('offers topography files by ending, case-insensitively', () => {
		const ext = (fileFilter('') as any)._and[1];
		expect(ext._or).toHaveLength(TOPOGRAPHY_EXTENSIONS.length);
		expect(ext._or[0]).toEqual({ filename_download: { _iends_with: '.al3d' } });
	});
	it('adds the typed text on the name or title', () => {
		const f = fileFilter('  edge ') as any;
		expect(f._and).toHaveLength(3);
		expect(f._and[2]).toEqual({ _or: [{ filename_download: { _icontains: 'edge' } }, { title: { _icontains: 'edge' } }] });
	});
	it('lists exactly the agreed endings: no hdf5 or sxm, none of the generic text and array formats', () => {
		expect([...TOPOGRAPHY_EXTENSIONS].sort()).toEqual(
			['.al3d', '.opd', '.opdx', '.x3p', '.ibw', '.h5', '.datx', '.sur', '.plu', '.apx', '.plux', '.vk3', '.vk4', '.vk6', '.vk7', '.lext', '.zon', '.os3d', '.sdf', '.frt', '.mnt', '.gwy', '.mdt', '.nms', '.oir', '.poir', '.ezd', '.nid', '.bcr', '.bcrf', '.tmd', '.zmg', '.mi', '.jpk', '.qep', '.spm'].sort(),
		);
		for (const generic of ['.tif', '.tiff', '.xyz', '.asc', '.hfm', '.npy', '.hdf5', '.sxm', '.mat', '.nc', '.txt', '.csv', '.dat']) {
			expect(TOPOGRAPHY_EXTENSIONS as readonly string[]).not.toContain(generic);
		}
	});
});

describe('normaliseFile', () => {
	it('reads a library row, with the archive path of a pointer row', () => {
		expect(normaliseFile({ id: 'f1', filename_download: 'a.al3d', filesize: '2048', metadata: { archive_path: 'Alicona/2026/a.al3d' } }))
			.toEqual({ id: 'f1', name: 'a.al3d', path: 'Alicona/2026/a.al3d', size: 2048 });
		expect(normaliseFile({ id: 'f2', title: 'T', metadata: '{"archive_path":"x/y.al3d"}', filesize: 7 })).toEqual({ id: 'f2', name: 'T', path: 'x/y.al3d', size: 7 });
	});
	it('names a file by its archive path when it has no name, and skips a row with no id', () => {
		expect(normaliseFile({ id: 'f3', metadata: { archive_path: 'x/z.al3d' } })?.name).toBe('z.al3d');
		expect(normaliseFile({ id: 'f4', metadata: 'not json' })).toEqual({ id: 'f4', name: '(file)', path: null, size: null });
		expect(normaliseFile({ filename_download: 'a' })).toBeNull();
	});
	it('prints sizes briefly', () => {
		expect([formatBytes(null), formatBytes(512), formatBytes(2048), formatBytes(5 * 1024 * 1024), formatBytes(300 * 1024 * 1024)]).toEqual(['', '512 B', '2.0 KB', '5.0 MB', '300 MB']);
	});
});

describe('formProblems', () => {
	it('is empty for a file and a condition', () => {
		expect(formProblems(ok(), TODAY)).toEqual([]);
	});
	it('asks for the file, then the condition', () => {
		expect(formProblems(emptyForm(), TODAY)).toEqual(['Choose a file from the library.', 'Choose the condition.']);
	});
	it('wants a note when the condition is other', () => {
		expect(formProblems(ok({ condition: 'other' }), TODAY)).toEqual(['Say in the note what the condition is.']);
		expect(formProblems(ok({ condition: 'other', note: 'glued' }), TODAY)).toEqual([]);
	});
	it('refuses a file the item already has, a malformed date and one in the future', () => {
		expect(formProblems(ok(), TODAY, ['f1'])).toEqual(['This file is already a surface scan of this item.']);
		expect(formProblems(ok({ date: '15/10/2026' }), TODAY)).toEqual(['The date is not a date.']);
		expect(formProblems(ok({ date: '2026-10-16' }), TODAY)).toEqual(['The scan date cannot be in the future.']);
		expect(formProblems(ok({ date: TODAY }), TODAY)).toEqual([]);
	});
});

describe('the rest', () => {
	it('writes today in the local calendar', () => {
		expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
	});
	it('asks for an edge’s operations, or those of any edge of the insert', () => {
		expect(operationFilter({ edgeId: 'e1', insertId: 'i1' })).toEqual({ insert_edge_id: { _eq: 'e1' } });
		expect(operationFilter({ insertId: 'i1' })).toEqual({ insert_edge_id: { insert_id: { _eq: 'i1' } } });
	});
	it('warns who sees the scan (its file’s owner, not the whole lab), and never says attach', () => {
		expect(VISIBILITY_WARNING).toBe(
			"Only the file's owner (or its team) and administrators see this scan's file and 3D view; others see that the item has a scan. Files with no owner stay visible to every lab member.",
		);
		expect(VISIBILITY_WARNING).not.toMatch(/makes this file visible to every lab member/);
		expect(VISIBILITY_WARNING.toLowerCase()).not.toContain('attach');
	});
});
