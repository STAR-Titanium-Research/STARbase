import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RECORD_VIEW, activityPeriod, activityWindow, isChanged, readRecordView, recordViewKey, viewSummary, withoutEmpty, writeRecordView,
	type RecordView,
} from './recordView';

function fakeStorage(initial: Record<string, string> = {}, broken = false): Storage {
	const data = new Map(Object.entries(initial));
	return {
		getItem: (k: string) => {
			if (broken) throw new Error('blocked');
			return data.get(k) ?? null;
		},
		setItem: (k: string, v: string) => {
			if (broken) throw new Error('blocked');
			data.set(k, v);
		},
	} as unknown as Storage;
}

describe('record view storage', () => {
	it('is stored per kind under d1.view.<kind>', () => {
		expect(recordViewKey('sample')).toBe('d1.view.sample');
	});

	it('starts at the default and reads back what was written', () => {
		const s = fakeStorage();
		expect(readRecordView('sample', s)).toEqual(DEFAULT_RECORD_VIEW);
		const view: RecordView = { panels: 2, density: 'roomy', empty: 'hide', range: '30d' };
		writeRecordView('sample', view, s);
		expect(readRecordView('sample', s)).toEqual(view);
		expect(readRecordView('project', s)).toEqual(DEFAULT_RECORD_VIEW);
	});

	it('keeps a good field next to a bad one', () => {
		const s = fakeStorage({ 'd1.view.sample': JSON.stringify({ panels: 3, density: 'compact', empty: 'maybe', range: 'all' }) });
		expect(readRecordView('sample', s)).toEqual({ ...DEFAULT_RECORD_VIEW, density: 'compact', range: 'all' });
	});

	it('falls back to the default for a broken value, blocked storage and no storage', () => {
		expect(readRecordView('sample', fakeStorage({ 'd1.view.sample': '{nope' }))).toEqual(DEFAULT_RECORD_VIEW);
		expect(readRecordView('sample', fakeStorage({ 'd1.view.sample': '[1]' }))).toEqual(DEFAULT_RECORD_VIEW);
		expect(readRecordView('sample', fakeStorage({}, true))).toEqual(DEFAULT_RECORD_VIEW);
		expect(readRecordView('sample', null)).toEqual(DEFAULT_RECORD_VIEW);
		expect(() => writeRecordView('sample', DEFAULT_RECORD_VIEW, fakeStorage({}, true))).not.toThrow();
		expect(() => writeRecordView('sample', DEFAULT_RECORD_VIEW, null)).not.toThrow();
	});
});

describe('isChanged and viewSummary', () => {
	it('is unchanged only at the default', () => {
		expect(isChanged({ ...DEFAULT_RECORD_VIEW })).toBe(false);
		expect(isChanged({ ...DEFAULT_RECORD_VIEW, panels: 2 })).toBe(true);
		expect(isChanged({ ...DEFAULT_RECORD_VIEW, empty: 'hide' })).toBe(true);
		expect(isChanged({ ...DEFAULT_RECORD_VIEW, range: '6mo' })).toBe(true);
	});

	it('names panels and density, then what is not the default', () => {
		expect(viewSummary({ ...DEFAULT_RECORD_VIEW }, false)).toBe('1 column · Normal');
		expect(viewSummary({ panels: 2, density: 'compact', empty: 'hide', range: '30d' }, false)).toBe('2 columns · Compact · Empty hidden');
		expect(viewSummary({ panels: 2, density: 'compact', empty: 'hide', range: '30d' }, true)).toBe('2 columns · Compact · Empty hidden · 30 d');
	});
});

describe('activity range', () => {
	it('maps to a window in weeks, 6 mo being the long-standing 26', () => {
		expect(activityWindow('30d')).toBe(5);
		expect(activityWindow('6mo')).toBe(26);
		expect(activityWindow('all')).toBe('all');
	});

	it('words the empty chart', () => {
		expect(`No operations or tests${activityPeriod('30d')}.`).toBe('No operations or tests in the last 30 days.');
		expect(`No operations or tests${activityPeriod('6mo')}.`).toBe('No operations or tests in the last 6 months.');
		expect(`No operations or tests${activityPeriod('all')}.`).toBe('No operations or tests.');
	});
});

describe('withoutEmpty', () => {
	const entries = [{ count: 3 }, { count: 0 }, { count: null }, { count: 0 }];
	it('keeps everything while empty sections are shown', () => {
		expect(withoutEmpty(entries, false)).toEqual({ shown: entries, hidden: 0 });
	});
	it('drops the zero counts and says how many, keeping sections with no count', () => {
		expect(withoutEmpty(entries, true)).toEqual({ shown: [{ count: 3 }, { count: null }], hidden: 2 });
	});
});
