import { describe, expect, it } from 'vitest';
import { isRailed, parseRailed, railBannerText, railedNames, shownRailed } from './railing';
import { RecordClient } from './liveClient';

describe('parseRailed', () => {
	it('keeps valid channel indices, sorted and distinct', () => {
		expect(parseRailed([5, 1, 5, 7])).toEqual([1, 5, 7]);
	});
	it('drops anything that is not a channel index, and tolerates a non-list', () => {
		expect(parseRailed([-1, 8, 2.5, '3', null, 4])).toEqual([4]);
		expect(parseRailed(undefined)).toEqual([]);
		expect(parseRailed('Fz1')).toEqual([]);
	});
});

describe('railedNames / isRailed / banner text', () => {
	it('names channels in raw-file order', () => {
		expect(railedNames([0, 3, 7])).toEqual(['Fx1', 'Fy2', 'Fz4']);
		expect(isRailed([3], 'Fy2')).toBe(true);
		expect(isRailed([3], 'Fy1')).toBe(false);
		expect(isRailed([], 'Fx1')).toBe(false);
	});
	it('says which channels and what to do', () => {
		expect(railBannerText([2])).toBe('Ch Fy1 railed - re-range before the next cut');
		expect(railBannerText([2, 5])).toBe('Ch Fy1, Ch Fz2 railed - re-range before the next cut');
	});
	it('says nothing when nothing railed', () => {
		expect(railBannerText([])).toBeNull();
	});
});

describe('RecordClient railed status', () => {
	it('follows the stream control message and is cleared by reset()', () => {
		const c = new RecordClient();
		expect(c.status.railed).toEqual([]);
		(c as any).onControl({ type: 'railed', channels: [6, 1] });
		expect(c.status.railed).toEqual([1, 6]);
		// The backend re-sends the full latched set; it replaces, never accumulates client-side.
		(c as any).onControl({ type: 'railed', channels: [1, 6, 7] });
		expect(c.status.railed).toEqual([1, 6, 7]);
		c.reset();
		expect(c.status.railed).toEqual([]);
	});
	it('a malformed message leaves nothing railed rather than throwing', () => {
		const c = new RecordClient();
		(c as any).onControl({ type: 'railed', channels: 'all' });
		expect(c.status.railed).toEqual([]);
	});
});

describe('shownRailed', () => {
	it('shows the railed set in Record mode and nothing in Playback', () => {
		expect(shownRailed('record', [2, 5])).toEqual([2, 5]);
		expect(shownRailed('playback', [2, 5])).toEqual([]);
	});
});
