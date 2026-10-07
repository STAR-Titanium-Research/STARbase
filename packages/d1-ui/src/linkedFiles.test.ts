import { describe, expect, it } from 'vitest';
import { DEFAULT_UNC_PREFIX, linkedFiles, parentUnc, shareFiles, toFileUri, toUnc } from './linkedFiles';

describe('path helpers', () => {
	it('maps an archive path to a UNC path, its folder and a file URI', () => {
		const unc = toUnc('runs/2026/a b.mat');
		expect(unc).toBe(`${DEFAULT_UNC_PREFIX}runs\\2026\\a b.mat`);
		expect(parentUnc(unc)).toBe(`${DEFAULT_UNC_PREFIX}runs\\2026`);
		expect(toFileUri(unc)).toBe('file://uosfstore.shef.ac.uk/shared/star_group1/runs/2026/a%20b.mat');
	});
});

describe('linkedFiles', () => {
	it('reads the archive path from object or string metadata', () => {
		const rows = linkedFiles([
			{ directus_files_id: { id: 'f1', filename_download: 'one.mat', metadata: { archive_path: 'a/one.mat' } } },
			{ directus_files_id: { id: 'f2', title: 'Two', metadata: '{"archive_path":"b/two.mat"}' } },
		]);
		expect(rows.map((r) => [r.id, r.name, r.kind])).toEqual([
			['f1', 'one.mat', 'archive'],
			['f2', 'Two', 'archive'],
		]);
		expect(rows[0].unc).toBe(`${DEFAULT_UNC_PREFIX}a\\one.mat`);
	});

	it('keeps an uploaded file (no archive path) as an upload', () => {
		const [row] = linkedFiles([{ directus_files_id: { id: 'f3', filename_download: 'photo.png', metadata: null } }]);
		expect(row).toMatchObject({ id: 'f3', name: 'photo.png', kind: 'upload', unc: null });
	});

	it('names an untitled archive file after its path', () => {
		const [row] = linkedFiles([{ directus_files_id: { id: 'f4', metadata: { archive_path: 'x/y/z.csv' } } }]);
		expect(row.name).toBe('z.csv');
	});

	it('skips a junction row whose file is unreadable, and survives bad metadata', () => {
		const rows = linkedFiles([
			{ directus_files_id: 'just-an-id' },
			null,
			{ directus_files_id: { id: 'f5', filename_download: 'x', metadata: '{broken' } },
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0].kind).toBe('upload');
	});

	it('handles no links at all', () => {
		expect(linkedFiles(null)).toEqual([]);
		expect(linkedFiles(undefined)).toEqual([]);
	});
});

describe('shareFiles', () => {
	it('turns operation_files rows into file rows with a copyable folder', () => {
		const rows = shareFiles([
			{ file_id: 'a', file_path: '\\\\host\\share\\runs\\one.mat', file_name: 'One' },
			{ file_id: 'b', file_path: 'X:/runs/two.csv' },
			{ file_id: 'c', file_path: '  ' },
			null,
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: 'a', name: 'One', kind: 'archive', folder: '\\\\host\\share\\runs', fileUri: null });
		expect(rows[1]).toMatchObject({ name: 'two.csv', folder: 'X:/runs' });
	});
	it('has no folder for a bare file name', () => {
		expect(shareFiles([{ file_id: 'd', file_path: 'one.mat' }])[0].folder).toBeNull();
	});
});
