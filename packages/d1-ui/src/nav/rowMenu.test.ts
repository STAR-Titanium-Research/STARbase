import { describe, expect, it } from 'vitest';
import { absoluteHref, rowMenuItems } from './rowMenu';

const ids = (o: Parameters<typeof rowMenuItems>[0]) => rowMenuItems(o).map((i) => i.id);

describe('rowMenuItems', () => {
	it('a section row offers Pin, Open in new tab and Copy link', () => {
		expect(ids({ kind: 'section', pinned: false, canPin: true })).toEqual(['pin', 'new-tab', 'copy']);
	});

	it('a pinned section row offers Unpin in place of Pin', () => {
		expect(ids({ kind: 'section', pinned: true, canPin: true })).toEqual(['unpin', 'new-tab', 'copy']);
	});

	it('a pinned row offers Unpin, Move up, Move down, then the two link items', () => {
		expect(ids({ kind: 'pinned', pinned: true, canPin: true, index: 1, count: 3 })).toEqual(['unpin', 'up', 'down', 'new-tab', 'copy']);
	});

	it('disables Move up at the top and Move down at the bottom', () => {
		const first = rowMenuItems({ kind: 'pinned', pinned: true, canPin: true, index: 0, count: 3 });
		expect(first.find((i) => i.id === 'up')?.disabled).toBe(true);
		expect(first.find((i) => i.id === 'down')?.disabled).toBe(false);
		const last = rowMenuItems({ kind: 'pinned', pinned: true, canPin: true, index: 2, count: 3 });
		expect(last.find((i) => i.id === 'up')?.disabled).toBe(false);
		expect(last.find((i) => i.id === 'down')?.disabled).toBe(true);
	});

	it('disables both for a lone pin', () => {
		const only = rowMenuItems({ kind: 'pinned', pinned: true, canPin: true, index: 0, count: 1 });
		expect(only.filter((i) => i.disabled).map((i) => i.id)).toEqual(['up', 'down']);
	});

	it('a page that cannot be pinned (or pins not loaded) has only the two link items', () => {
		expect(ids({ kind: 'section', pinned: false, canPin: false })).toEqual(['new-tab', 'copy']);
	});
});

describe('absoluteHref', () => {
	it('keeps an absolute address', () => {
		expect(absoluteHref('https://d1.example/admin/x', 'https://app.example')).toBe('https://d1.example/admin/x');
	});

	it('puts the origin before a relative one', () => {
		expect(absoluteHref('/admin/home/samples', 'https://d1.example')).toBe('https://d1.example/admin/home/samples');
		expect(absoluteHref('/samples', 'https://app.example/')).toBe('https://app.example/samples');
	});

	it('copes with a hash-style href', () => {
		expect(absoluteHref('#/samples', 'https://app.example')).toBe('https://app.example/#/samples');
	});
});
