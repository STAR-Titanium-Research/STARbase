import { describe, expect, it } from 'vitest';
import { CHANGELOG } from './changelog';
import { groupNotes, NOTE_PREFIXES } from './changelogGroups';

describe('groupNotes (#137)', () => {
	it('splits notes into New, Improved and Fixed, in that order, stripping the label prefix', () => {
		const out = groupNotes([
			'Fixed: the FFT stayed blank.',
			'Record page: a pre-flight checklist.',
			'Improved: the plot loads faster.',
			'New: a Move panel button.',
			'Fixed: upload no longer stalls.',
		]);
		expect(out.map((g) => g.label)).toEqual(['New', 'Improved', 'Fixed']);
		expect(out[0].notes).toEqual(['Record page: a pre-flight checklist.', 'a Move panel button.']);
		expect(out[1].notes).toEqual(['the plot loads faster.']);
		expect(out[2].notes).toEqual(['the FFT stayed blank.', 'upload no longer stalls.']);
	});

	it('leaves out empty groups', () => {
		expect(groupNotes(['Fixed: one.']).map((g) => g.key)).toEqual(['fixed']);
		expect(groupNotes(['Plain note.']).map((g) => g.key)).toEqual(['new']);
		expect(groupNotes([])).toEqual([]);
	});

	it('files Security under Fixed and keeps its prefix', () => {
		const out = groupNotes(['Security: the relay token is no longer logged.']);
		expect(out).toEqual([{ key: 'fixed', label: 'Fixed', notes: ['Security: the relay token is no longer logged.'] }]);
	});

	it('treats an area prefix, a lower-case prefix and a missing space as ordinary New text', () => {
		for (const n of ['Plot page: x', 'fixed: x', 'Fixed:x', 'Fixed', 'toString: x']) {
			expect(groupNotes([n])).toEqual([{ key: 'new', label: 'New', notes: [n] }]);
		}
	});
});

describe('the bundled CHANGELOG', () => {
	it('uses only known spellings for the category prefixes', () => {
		// A typo like "Fix:" or "fixed:" would silently land in New. Area prefixes ("Plot page:")
		// are free text; what is checked is that nothing that looks like a category is misspelt.
		const looksLikeCategory = /^(fix|fixes|fixed|improve|improved|improvement|improvements|new|added|security)$/i;
		const bad: string[] = [];
		for (const c of CHANGELOG) {
			for (const n of c.notes) {
				const m = /^([A-Za-z]+):/.exec(n);
				if (m && looksLikeCategory.test(m[1]) && !Object.hasOwn(NOTE_PREFIXES, m[1])) bad.push(`${c.version}: ${n.slice(0, 40)}`);
				if (m && Object.hasOwn(NOTE_PREFIXES, m[1]) && !/^[A-Za-z]+:\s+\S/.test(n)) bad.push(`${c.version}: ${n.slice(0, 40)}`);
			}
		}
		expect(bad).toEqual([]);
	});

	it('every entry groups without losing a note', () => {
		for (const c of CHANGELOG) {
			const total = groupNotes(c.notes).reduce((n, g) => n + g.notes.length, 0);
			expect(total, c.version).toBe(c.notes.length);
		}
	});
});
