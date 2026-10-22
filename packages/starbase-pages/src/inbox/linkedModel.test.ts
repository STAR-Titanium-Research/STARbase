import { describe, expect, it } from 'vitest';
import { recordRoute } from '@d1/ui';
import { foundFile } from './fakeInboxServer';
import type { FoundFile } from './inboxApi';
import { CHANGE_HALF_DONE, SIBLINGS_SHOWN, changeBlocked, hasSiblings, linkCardView, siblingsView, undoConfirmText } from './linkedModel';

const REC = '00000000-0000-4000-8000-000000000101';
const linked = (over: Partial<FoundFile> = {}): FoundFile =>
	foundFile({
		kind: 'sem_image', state: 'linked', link_kind: 'manual', link_batch_id: 'b1', link_batch_size: 1, decided_at: '2026-10-22T14:05:00.000Z', decided_by_name: 'Alice A',
		linked_collection: 'physical_samples', linked_record_id: REC, linked_label: 'S-0042', linked_title: 'Ti-6Al-4V fatigue bar', ...over,
	});

describe('linkCardView: what the card says for each kind of link', () => {
	it('a sample: the code, its title, who, how and when, and the record page', () => {
		const v = linkCardView(linked())!;
		expect(v).toMatchObject({ lead: 'Linked to', code: 'S-0042', openLabel: 'Open sample', route: recordRoute('physical_samples', REC), scan: false, batch: 1 });
		expect(v.meta).toBe('Ti-6Al-4V fatigue bar · by Alice A · manually · 22 Oct 2026');
	});

	it('an operation and a test: their own noun and page, and no title when there is none', () => {
		const op = linkCardView(linked({ linked_collection: 'manufacturing_operations', linked_label: 'OP-0188', linked_title: null, link_kind: 'auto' }))!;
		expect(op).toMatchObject({ code: 'OP-0188', openLabel: 'Open operation', route: recordRoute('manufacturing_operations', REC) });
		expect(op.meta).toBe('by Alice A · automatically · 22 Oct 2026');
		const test = linkCardView(linked({ linked_collection: 'test_sessions', linked_label: 'T-0311', link_kind: 'bulk' }))!;
		expect(test).toMatchObject({ code: 'T-0311', openLabel: 'Open test', route: recordRoute('test_sessions', REC) });
		expect(test.meta).toContain('accepted in bulk');
	});

	it('a surface scan: added to an edge or an insert, routed to it, never changed', () => {
		const edge = linkCardView(linked({ kind: 'surface_scan', linked_collection: 'surface_scans', linked_record_id: 'scan1', linked_label: 'H13A-#2-fC (worn)', linked_edge_id: 'e1', linked_title: null }))!;
		expect(edge).toMatchObject({ lead: 'Added as a surface scan of', code: 'H13A-#2-fC (worn)', openLabel: 'Open edge', route: recordRoute('insert_edges', 'e1'), scan: true });
		expect(changeBlocked(edge)).toMatch(/not linked to a record/);
		const insert = linkCardView(linked({ kind: 'surface_scan', linked_collection: 'surface_scans', linked_record_id: 'scan1', linked_label: 'H13A-#2 (new)', linked_insert_id: 'i1', linked_title: null }))!;
		expect(insert).toMatchObject({ openLabel: 'Open insert', route: recordRoute('cutting_inserts', 'i1') });
	});

	it('a record the caller cannot read is not named: no code, no page', () => {
		const v = linkCardView(linked({ linked_collection: null, linked_record_id: null, linked_label: null, linked_title: null }))!;
		expect(v).toMatchObject({ code: null, route: null, openLabel: 'Open record' });
	});

	it('a file that is not linked has no card', () => {
		expect(linkCardView(foundFile())).toBeNull();
		expect(linkCardView(foundFile({ state: 'dismissed' }))).toBeNull();
	});
});

describe('Change and Undo: a batch is undone whole', () => {
	it('a batch of one can be changed and the confirm says the file goes back; a bigger one says how many go and blocks Change with the reason', () => {
		const one = linkCardView(linked({ link_batch_size: 1 }))!;
		expect(changeBlocked(one)).toBeNull();
		expect(undoConfirmText(one)).toBe('The file goes back to your Inbox.');
		const two = linkCardView(linked({ link_batch_size: 2 }))!;
		expect(changeBlocked(two)).toBe('This file was linked together with 1 other. Undo that link first to link this one elsewhere.');
		const five = linkCardView(linked({ link_batch_size: 5 }))!;
		expect(changeBlocked(five)).toContain('with 4 others');
		expect(undoConfirmText(five)).toBe('This undoes the link of all 5 files linked together. They go back to your Inbox.');
	});

	it('an older server that sends no batch size is read as a batch of one', () => {
		expect(linkCardView(linked({ link_batch_size: null }))!.batch).toBe(1);
		expect(linkCardView(linked({ link_batch_size: undefined }))!.batch).toBe(1);
	});

	it('has words for a change whose new link was refused', () => {
		expect(CHANGE_HALF_DONE).toMatch(/old link was removed/);
	});
});

describe('the strip of siblings', () => {
	const others = (n: number) => Array.from({ length: n }, () => linked());
	it('shows up to six and counts the rest; the count includes this picture', () => {
		const v = siblingsView(others(SIBLINGS_SHOWN), 11)!;
		expect(v.shown).toHaveLength(6);
		expect(v).toMatchObject({ more: 5, count: 12, countText: '12 images' });
	});

	it('has no "+N" when every other picture is drawn; two pictures say "2 images"', () => {
		expect(siblingsView(others(1), 1)).toMatchObject({ more: 0, count: 2, countText: '2 images' });
		expect(siblingsView(others(6), 6)).toMatchObject({ more: 0, count: 7 });
	});

	it('is nothing when there is no other picture', () => {
		expect(siblingsView([], 0)).toBeNull();
	});

	it('is looked for only for a linked picture on a sample, operation or test', () => {
		expect(hasSiblings(linked())).toBe(true);
		expect(hasSiblings(linked({ kind: 'image' }))).toBe(true);
		expect(hasSiblings(linked({ kind: 'document' }))).toBe(false);
		expect(hasSiblings(linked({ kind: 'surface_scan', linked_collection: 'surface_scans' }))).toBe(false);
		expect(hasSiblings(linked({ linked_record_id: null }))).toBe(false);
		expect(hasSiblings(foundFile({ kind: 'sem_image' }))).toBe(false);
	});
});
