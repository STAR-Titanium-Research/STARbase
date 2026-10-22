import { describe, expect, it } from 'vitest';
import { progressFolder } from './fakeInboxServer';
import {
	FOLDERS_KNOWN_HELP, allComplete, barTone, countText, formatPercent, isComplete, loginText, measuresOf, percent, sortFolders,
} from './progressModel';

describe('percent', () => {
	it('is done over total as 0 to 100', () => {
		expect(percent(1, 4)).toBe(25);
		expect(percent(300, 300)).toBe(100);
		expect(percent(0, 7)).toBe(0);
	});
	it('is null (nothing to measure) when the denominator is 0, never NaN or Infinity', () => {
		expect(percent(0, 0)).toBeNull();
		expect(percent(5, 0)).toBeNull();
		expect(percent(1, -3)).toBeNull();
		expect(percent(Number.NaN, 4)).toBeNull();
		expect(percent(1, Number.POSITIVE_INFINITY)).toBeNull();
	});
	it('stays inside 0 to 100 when the counts disagree (a count read a moment before the other)', () => {
		expect(percent(12, 10)).toBe(100);
		expect(percent(-2, 10)).toBe(0);
	});
});

describe('formatPercent', () => {
	it('writes a dash for none, whole numbers without a decimal and the rest with one', () => {
		expect(formatPercent(null)).toBe('—');
		expect(formatPercent(Number.NaN)).toBe('—');
		expect(formatPercent(0)).toBe('0%');
		expect(formatPercent(50)).toBe('50%');
		expect(formatPercent(99.8)).toBe('99.8%');
		expect(formatPercent(12.54)).toBe('12.5%');
		expect(formatPercent(100)).toBe('100%');
	});
	it('never rounds up to 100%: 100% means everything is done', () => {
		expect(formatPercent(99.96)).toBe('99.9%');
		expect(formatPercent(99.999)).toBe('99.9%');
		expect(formatPercent(percent(2999, 3000))).toBe('99.9%');
	});
	it('never shows 0% for something that has started', () => {
		expect(formatPercent(0.02)).toBe('0.1%');
		expect(formatPercent(percent(1, 10000))).toBe('0.1%');
	});
});

describe('measuresOf', () => {
	it('has the four measures, in the order the page shows them, with their counts', () => {
		const m = measuresOf(progressFolder({ folders_known: 20, folders_listed: 19, images: 1000, images_read: 998, images_with_thumb: 500, sem: 400, sem_with_scale: 400 }));
		expect(m.map((x) => x.label)).toEqual(['Folders listed', 'Images read', 'Thumbnails', 'SEM images with a scale']);
		expect(m.map((x) => [x.done, x.total])).toEqual([[19, 20], [998, 1000], [500, 1000], [400, 400]]);
		expect(m.map((x) => x.pct)).toEqual([95, 99.8, 50, 100]);
	});
	it('a measure with nothing to count is null', () => {
		const m = measuresOf(progressFolder({ folders_known: 3, folders_listed: 3, images: 0, images_read: 0, images_with_thumb: 0, sem: 0, sem_with_scale: 0 }));
		expect(m.map((x) => x.pct)).toEqual([100, null, null, null]);
	});
	it('counts read as "12 of 340" for a tooltip', () => {
		expect(countText({ done: 12, total: 340 })).toBe('12 of 340');
		expect(countText({ done: 1234, total: 5678 })).toBe('1,234 of 5,678');
	});
});

describe('isComplete', () => {
	it('is true when every measure that has something to measure is at 100%', () => {
		expect(isComplete(progressFolder())).toBe(true);
		expect(isComplete(progressFolder({ images: 0, images_read: 0, images_with_thumb: 0, sem: 0, sem_with_scale: 0 }))).toBe(true);
	});
	it('is false when one measure is short, even by one', () => {
		expect(isComplete(progressFolder({ images_with_thumb: 299 }))).toBe(false);
		expect(isComplete(progressFolder({ folders_listed: 11 }))).toBe(false);
		expect(isComplete(progressFolder({ sem_with_scale: 119 }))).toBe(false);
	});
	it('is false for a folder the crawler has not seen anything in yet: it is waiting for its first scan', () => {
		expect(isComplete(progressFolder({ folders_known: 0, folders_listed: 0, files: 0, images: 0, images_read: 0, images_with_thumb: 0, sem: 0, sem_with_scale: 0 }))).toBe(false);
	});
	it('allComplete is true for no folder at all and false when one is short', () => {
		expect(allComplete([])).toBe(true);
		expect(allComplete([progressFolder(), progressFolder({ images_read: 10 })])).toBe(false);
		expect(allComplete([progressFolder(), progressFolder()])).toBe(true);
	});
});

describe('barTone', () => {
	it('is ok at 100% and neutral for nothing to measure', () => {
		expect(barTone(100, false)).toBe('ok');
		expect(barTone(100, true)).toBe('ok');
		expect(barTone(null, true)).toBe('neutral');
	});
	it('is warn only below 50% once a scan has finished', () => {
		expect(barTone(49.9, true)).toBe('warn');
		expect(barTone(0, true)).toBe('warn');
		expect(barTone(50, true)).toBe('neutral');
		expect(barTone(99.8, true)).toBe('neutral');
		expect(barTone(10, false)).toBe('neutral');
	});
});

describe('sortFolders and loginText', () => {
	const a = progressFolder({ files: 5, owner: { id: 'a', name: 'Zed' } });
	const b = progressFolder({ files: 500, owner: { id: 'b', name: 'Mia', has_login: false } });
	const c = progressFolder({ files: 5, owner: { id: 'c', name: 'Abe', kind: 'team', has_login: null } });
	it('puts the folder with the most files first, then by name, and leaves the list it was given alone', () => {
		const list = [a, b, c];
		expect(sortFolders(list).map((f) => f.owner.name)).toEqual(['Mia', 'Abe', 'Zed']);
		expect(list.map((f) => f.owner.name)).toEqual(['Zed', 'Mia', 'Abe']);
	});
	it('says login, no login or team folder', () => {
		expect([loginText(a), loginText(b), loginText(c)]).toEqual(['login', 'no login', 'team folder']);
	});
});

describe('the help text', () => {
	it('says that folders known are the ones the crawler has seen', () => {
		expect(FOLDERS_KNOWN_HELP).toMatch(/seen so far/);
		expect(FOLDERS_KNOWN_HELP).toMatch(/100%/);
	});
});
