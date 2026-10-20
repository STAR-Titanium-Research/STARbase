import { describe, expect, it } from 'vitest';
import { createFakeInbox, foundFile } from './fakeInboxServer';
import { LOCATE_PAGE, locateFile } from './inboxFileList';
import { DEFAULT_FILTERS } from './inboxModel';

const many = (n: number, over = {}) => Array.from({ length: n }, (_, i) => foundFile({ kind: 'image', rel_path: `Users/ab1cd/images/f${String(i).padStart(4, '0')}.tif`, ...over }));

describe('locateFile', () => {
	it('finds a file in the first page, with the whole list size and its neighbours read', async () => {
		const files = many(5);
		const fake = createFakeInbox({ files });
		const got = await locateFile(fake.api, DEFAULT_FILTERS, files[2].candidate_id);
		expect(got?.part).toBe('main');
		expect(got?.total).toBe(5);
		expect(got?.rows.map((f) => f.candidate_id)).toEqual(files.map((f) => f.candidate_id));
	});

	it('reads on to the page that holds the file, and one page further when the file ends a page', async () => {
		const files = many(LOCATE_PAGE + 30);
		const fake = createFakeInbox({ files });
		const deep = await locateFile(fake.api, DEFAULT_FILTERS, files[LOCATE_PAGE + 3].candidate_id);
		expect(deep?.rows).toHaveLength(LOCATE_PAGE + 30);
		expect(deep?.total).toBe(LOCATE_PAGE + 30);
		const lastOfPage = await locateFile(fake.api, DEFAULT_FILTERS, files[LOCATE_PAGE - 1].candidate_id);
		expect(lastOfPage?.rows.length).toBe(LOCATE_PAGE + 30); // the next page was read, so there is a next file
		const calls = fake.calls.filter((c) => c.path === '/d1-inbox/files');
		expect(calls.every((c) => (c.params as any).limit === LOCATE_PAGE)).toBe(true);
	});

	it('looks in the Other files part when the picture rows do not have it', async () => {
		const doc = foundFile({ kind: 'document', rel_path: 'Users/ab1cd/notes.pdf' });
		const fake = createFakeInbox({ files: [...many(3), doc] });
		const got = await locateFile(fake.api, DEFAULT_FILTERS, doc.candidate_id);
		expect(got).toMatchObject({ part: 'other', total: 1 });
		expect(got?.rows.map((f) => f.candidate_id)).toEqual([doc.candidate_id]);
	});

	it('uses the list filters: a file the filters leave out is not found', async () => {
		const files = [foundFile({ kind: 'sem_image', rel_path: 'Users/ab1cd/a.tif' }), foundFile({ kind: 'image', rel_path: 'Users/ab1cd/b.tif' })];
		const fake = createFakeInbox({ files });
		expect(await locateFile(fake.api, { ...DEFAULT_FILTERS, kind: 'sem_image' }, files[1].candidate_id)).toBeNull();
		expect((await locateFile(fake.api, { ...DEFAULT_FILTERS, kind: 'sem_image' }, files[0].candidate_id))?.total).toBe(1);
	});

	it('answers null for an unknown id, and stops when a newer request has taken over', async () => {
		const files = many(3);
		const fake = createFakeInbox({ files });
		expect(await locateFile(fake.api, DEFAULT_FILTERS, 'nope')).toBeNull();
		expect(await locateFile(fake.api, DEFAULT_FILTERS, files[0].candidate_id, () => true)).toBeNull();
	});
});
