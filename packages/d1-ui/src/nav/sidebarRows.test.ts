import { describe, expect, it } from 'vitest';
import { HOME_LINK, INBOX_LINK, viewAsRow } from './sidebarRows';
import type { SidebarLink } from './sidebarModel';

describe('HOME_LINK', () => {
	it('is the Home page, with nothing to pin', () => {
		expect(HOME_LINK.to).toBe('/home');
		expect(HOME_LINK.pin).toBeNull();
		expect(HOME_LINK.newTab).toBe(false);
	});
});

describe('INBOX_LINK', () => {
	it('is the Inbox page with nothing to pin, written as STARbase\'s own page (no /home form)', () => {
		expect(INBOX_LINK.to).toBe('/inbox');
		expect(INBOX_LINK.label).toBe('Inbox');
		expect(INBOX_LINK.icon).toBe('inbox');
		expect(INBOX_LINK.pin).toBeNull();
		expect(INBOX_LINK.newTab).toBe(false);
	});
});

describe('viewAsRow', () => {
	const link: SidebarLink = {
		label: 'Tests', to: '/home/tests', newTab: false, icon: 'clipboard-check', collection: 'test_sessions',
		pin: { kind: 'page', target: 'tests' }, views: [],
	};

	it('keeps the view, its address and its own pin target, with the index page icon', () => {
		const row = viewAsRow(link, { id: 7, label: 'Failed tests', to: '/home/tests?bookmark=7', pin: { kind: 'view', target: '7' } });
		expect(row).toEqual({
			ref: { kind: 'view', target: '7' },
			label: 'Failed tests',
			hint: null,
			to: '/home/tests?bookmark=7',
			icon: 'clipboard-check',
		});
	});
});
