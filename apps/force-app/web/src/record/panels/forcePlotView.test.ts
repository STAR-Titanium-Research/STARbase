import { describe, expect, it } from 'vitest';
import { forcePlotView, showWindowControl } from './forcePlotView';

describe('forcePlotView (#189)', () => {
	it('shows the finished plot once the cut is done and the cache is loaded', () => {
		expect(forcePlotView({ mode: 'time', isDone: true, hasCache: true })).toBe('finished');
	});
	it('stays live before the cut ends, before the cache loads, and in other modes', () => {
		expect(forcePlotView({ mode: 'time', isDone: false, hasCache: true })).toBe('live');
		expect(forcePlotView({ mode: 'time', isDone: true, hasCache: false })).toBe('live');
		expect(forcePlotView({ mode: 'spectrogram', isDone: true, hasCache: true })).toBe('live');
	});
});

describe('showWindowControl', () => {
	it('is hidden over the finished plot and for spectrum modes, shown otherwise', () => {
		expect(showWindowControl('time', 'live')).toBe(true);
		expect(showWindowControl('time', 'finished')).toBe(false);
		expect(showWindowControl('fft', 'live')).toBe(false);
		expect(showWindowControl('psd', 'live')).toBe(false);
		expect(showWindowControl('spectrogram', 'live')).toBe(true);
	});
});
