import { describe, expect, it } from 'vitest';
import { foundFile } from './fakeInboxServer';
import type { IgnoredRule } from './inboxApi';
import { IGNORE_HINT, MAX_FOLDER_LENGTH, coveringRule, folderProblem, ignoreConfirm, ignoreTarget, ignoredText, isBelow, knownFolders, ownerKey, shownBelow, unignoredText } from './ignoredFolders';

const TEAM = { kind: 'team', id: 't1', name: 'SEM team' } as const;
const rule = (folder: string, owner: IgnoredRule['owner'] = { kind: 'person', id: 'p1', name: 'Ann Lee' }): IgnoredRule => ({ ignored_id: `r-${folder}`, folder, owner, created_at: null, can_remove: true });

describe('ignoreTarget', () => {
	it('is the folder relative to the owner\'s root, never Users/<alias>', () => {
		expect(ignoreTarget(foundFile({ rel_path: 'Users/ab1cd/World-Ti Paper/Drafts/a.tif' }))).toEqual({ folder: 'World-Ti Paper/Drafts', teamId: null, ownerName: 'Ann Lee', ownerKind: 'person' });
		expect(ignoreTarget(foundFile({ rel_path: 'Users/ab1cd/sem/a.tif' }))?.folder).toBe('sem');
	});

	it('belongs to the team for a file in a team folder', () => {
		expect(ignoreTarget(foundFile({ rel_path: 'Shared/SEM/Old runs/a.tif', owner: TEAM }))).toEqual({ folder: 'Old runs', teamId: 't1', ownerName: 'SEM team', ownerKind: 'team' });
	});

	it('is null for a file directly in the root, a path outside Users and Shared, and a team row with no team id', () => {
		expect(ignoreTarget(foundFile({ rel_path: 'Users/ab1cd/a.tif' }))).toBeNull();
		expect(ignoreTarget(foundFile({ rel_path: 'Shared/SEM/a.tif', owner: TEAM }))).toBeNull();
		expect(ignoreTarget(foundFile({ rel_path: 'Other/x/y/a.tif' }))).toBeNull();
		expect(ignoreTarget(foundFile({ rel_path: 'Shared/SEM/Old/a.tif', owner: { kind: 'team', id: null, name: 'SEM team' } }))).toBeNull();
	});
});

describe('isBelow', () => {
	it('covers the folder and what is under it, on whole parts, ignoring case', () => {
		expect(isBelow('World-Ti Paper', 'World-Ti Paper')).toBe(true);
		expect(isBelow('world-ti paper/Drafts/v2', 'World-Ti Paper')).toBe(true);
		expect(isBelow('World-Ti Paper 2', 'World-Ti Paper')).toBe(false);
		expect(isBelow('World-Ti', 'World-Ti Paper')).toBe(false);
		expect(isBelow('anything', '')).toBe(false);
	});
});

describe('shownBelow', () => {
	it('counts the open files of the same owner at or below the folder', () => {
		const t = ignoreTarget(foundFile({ rel_path: 'Users/ab1cd/Paper/x.tif' }))!;
		const rows = [
			foundFile({ rel_path: 'Users/ab1cd/Paper/a.tif' }),
			foundFile({ rel_path: 'Users/ab1cd/paper/Drafts/b.tif' }),
			foundFile({ rel_path: 'Users/ab1cd/Paper 2/c.tif' }),
			foundFile({ rel_path: 'Users/ab1cd/Paper/d.tif', state: 'dismissed' }),
			foundFile({ rel_path: 'Shared/SEM/Paper/e.tif', owner: TEAM }),
		];
		expect(shownBelow(rows, t)).toBe(2);
	});
});

describe('folderProblem', () => {
	it('accepts a plain relative folder', () => {
		for (const ok of ['sem', 'World-Ti Paper/Drafts', ' sem ', 'a.b/c..d', 'x/.hidden']) expect(folderProblem(ok), ok).toBeNull();
	});

	it('refuses what the server refuses, in words', () => {
		const cases: Array<[string, RegExp]> = [
			['', /Type or choose/],
			['   ', /Type or choose/],
			['/sem', /start or end with a slash/],
			['sem/', /start or end with a slash/],
			['a//b', /empty part/],
			['a/./b', /\. or \.\./],
			['a/../b', /\. or \.\./],
			['..', /\. or \.\./],
			['a\\b', /not \\/],
			['a\u0001b', /not allowed/],
			['x'.repeat(MAX_FOLDER_LENGTH + 1), /too long/],
		];
		for (const [value, re] of cases) expect(folderProblem(value), JSON.stringify(value)).toMatch(re);
	});
});

describe('knownFolders', () => {
	const rows = [
		foundFile({ rel_path: 'Users/ab1cd/Paper/Drafts/a.tif' }),
		foundFile({ rel_path: 'Users/ab1cd/paper/b.tif' }),
		foundFile({ rel_path: 'Users/ab1cd/sem/c.tif' }),
		foundFile({ rel_path: 'Users/ab1cd/root.tif' }),
		foundFile({ rel_path: 'Shared/SEM/Old runs/d.tif', owner: TEAM }),
	];

	it('lists the folders of the loaded rows and the folders above them, once each, for one owner', () => {
		expect(knownFolders(rows, 'me', [])).toEqual(['Paper', 'Paper/Drafts', 'sem']);
		expect(knownFolders(rows, ownerKey(TEAM), [])).toEqual(['Old runs']);
	});

	it('leaves out the folders already ignored (any letter case) for that owner only', () => {
		expect(knownFolders(rows, 'me', [rule('paper')])).toEqual(['Paper/Drafts', 'sem']);
		expect(knownFolders(rows, 'me', [rule('Old runs', TEAM)])).toEqual(['Paper', 'Paper/Drafts', 'sem']);
	});

	it('stops at the cap', () => {
		const many = Array.from({ length: 30 }, (_, i) => foundFile({ rel_path: `Users/ab1cd/f${String(i).padStart(2, '0')}/x.tif` }));
		expect(knownFolders(many, 'me', [], 10)).toHaveLength(10);
	});
});

describe('coveringRule', () => {
	it('is another rule of the same owner at or above the folder (the broadest), else null', () => {
		const removed = rule('Paper/Drafts');
		expect(coveringRule([rule('Paper/Drafts'), rule('Paper')], removed)?.folder).toBe('Paper');
		expect(coveringRule([rule('Paper/Drafts/v2'), rule('Paper/Drafts', TEAM)], removed)).toBeNull();
		expect(coveringRule([rule('Paper 2'), rule('Other')], removed)).toBeNull();
		// the same folder under another rule id (the other rule of a duplicate) also covers it; the removed rule itself never does
		expect(coveringRule([{ ...rule('paper/drafts'), ignored_id: 'other' }], removed)?.ignored_id).toBe('other');
		expect(coveringRule([removed], removed)).toBeNull();
	});
});

describe('words', () => {
	it('the confirm says exactly what happens, with the count as an estimate', () => {
		expect(ignoreConfirm({ folder: 'World-Ti Paper' }, 0)).toEqual({
			title: 'Stop scanning World-Ti Paper?',
			lines: [
				'The crawler stops looking for new files in World-Ti Paper and below.',
				'Files there that are still in your Inbox move to Dismissed. You can restore them.',
				'Files already linked stay linked and tracked. Nothing on the share is changed.',
			],
		});
		expect(ignoreConfirm({ folder: 'x' }, 1).lines[1]).toBe('Files there that are still in your Inbox (1 found file shown here) move to Dismissed. You can restore them.');
		expect(ignoreConfirm({ folder: 'x' }, 3).lines[1]).toContain('(3 found files shown here)');
	});

	it('the notices use the server\'s numbers', () => {
		expect(ignoredText('Paper', 12)).toBe('Ignoring Paper. 12 found files moved to Dismissed.');
		expect(ignoredText('Paper', 1)).toBe('Ignoring Paper. 1 found file moved to Dismissed.');
		expect(ignoredText('Paper', 0)).toBe('Ignoring Paper. No found files moved to Dismissed.');
		expect(unignoredText('Paper', true)).toContain('A rescan is queued');
		expect(unignoredText('Paper', false)).toContain('at the next scan');
		expect(unignoredText('Paper', false)).toContain('stay in Dismissed');
	});

	it('removing a rule another rule still covers says so, names that rule when it is known, and does not mention a rescan', () => {
		expect(unignoredText('Paper/Drafts', false, true, 'Paper')).toBe('Rule removed. Paper/Drafts is still ignored by another rule (Paper).');
		expect(unignoredText('Paper/Drafts', false, true)).toBe('Rule removed. Paper/Drafts is still ignored by another rule.');
		expect(unignoredText('Paper/Drafts', true, true, 'Paper')).not.toMatch(/rescan|next scan/i);
	});

	it('the hint says what stops: new files are not looked for', () => {
		expect(IGNORE_HINT).toBe('The crawler stops looking for new files in these folders and below. Nothing on the share is changed.');
	});
});
