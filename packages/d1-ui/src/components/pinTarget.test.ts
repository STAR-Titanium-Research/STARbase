import { describe, expect, it } from 'vitest';
import { pinTargetForIndex, pinTargetForRecord } from './pinTarget';

const ID = '123e4567-e89b-12d3-a456-426614174000';

describe('pinTargetForIndex', () => {
	it('pins the page when no saved view is open', () => {
		expect(pinTargetForIndex('/home/samples', null)).toEqual({ kind: 'page', target: 'samples' });
		expect(pinTargetForIndex('/admin/home/projects/', null)).toEqual({ kind: 'page', target: 'projects' });
	});

	it('pins the saved view, as the preset id, when one is open', () => {
		expect(pinTargetForIndex('/home/samples', 42)).toEqual({ kind: 'view', target: '42' });
	});

	it('has nothing to pin on a path that is not a page, unless a saved view is open', () => {
		expect(pinTargetForIndex('/home/nothing-here', null)).toBeNull();
		expect(pinTargetForIndex('/home/nothing-here', 7)).toEqual({ kind: 'view', target: '7' });
	});

	it('ignores a bookmark id that is not a whole number', () => {
		expect(pinTargetForIndex('/home/samples', Number.NaN)).toEqual({ kind: 'page', target: 'samples' });
		expect(pinTargetForIndex('/home/samples', -1)).toEqual({ kind: 'page', target: 'samples' });
		expect(pinTargetForIndex('/home/samples', 1.5)).toEqual({ kind: 'page', target: 'samples' });
	});
});

describe('pinTargetForRecord', () => {
	it('pins the record by collection and id', () => {
		expect(pinTargetForRecord('physical_samples', ID)).toEqual({ kind: 'record', target: `physical_samples:${ID}` });
	});

	it('has nothing to pin for an unknown collection or an id that is not a uuid', () => {
		expect(pinTargetForRecord('nothing', ID)).toBeNull();
		expect(pinTargetForRecord('physical_samples', 'abc')).toBeNull();
		expect(pinTargetForRecord('physical_samples', '')).toBeNull();
	});
});
