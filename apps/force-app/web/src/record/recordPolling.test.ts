import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntervalGate, shouldPollBackup, shouldPollDisk, shouldPollPreflight, syncDiskGate } from './recordPolling';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('what is polled (2.6)', () => {
	it('polls disk only while recording in record mode', () => {
		expect(shouldPollDisk('record', 'recording')).toBe(true);
		expect(shouldPollDisk('record', 'finalizing')).toBe(false);
		expect(shouldPollDisk('record', 'idle')).toBe(false);
		expect(shouldPollDisk('playback', 'recording')).toBe(false);
	});
	it('polls the pre-Start checklist inputs only while waiting to start, in record mode', () => {
		expect(shouldPollPreflight('record', 'idle')).toBe(true);
		expect(shouldPollPreflight('record', 'done')).toBe(true);
		expect(shouldPollPreflight('record', 'error')).toBe(true);
		expect(shouldPollPreflight('record', 'recording')).toBe(false);
		expect(shouldPollPreflight('record', 'finalizing')).toBe(false);
		expect(shouldPollPreflight('playback', 'idle')).toBe(false);
	});
	it('polls backup progress only when a backup is configured', () => {
		expect(shouldPollBackup('record', 'recording', false)).toBe(false);
		expect(shouldPollBackup('record', 'recording', true)).toBe(true);
	});
});

describe('IntervalGate', () => {
	it('starts at once and then on the interval when turned on while already recording (a remount)', () => {
		const fn = vi.fn();
		const g = new IntervalGate(fn, 1000);
		g.set(shouldPollDisk('record', 'recording'));   // what the immediate watcher does on mount
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2500);
		expect(fn).toHaveBeenCalledTimes(3);
		g.stop();
	});

	it('does not start twice and stops (with a final call) when turned off', () => {
		const fn = vi.fn(); const done = vi.fn();
		const g = new IntervalGate(fn, 1000, done);
		g.set(true); g.set(true);
		expect(fn).toHaveBeenCalledTimes(1);
		g.set(false);
		expect(done).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5000);
		expect(fn).toHaveBeenCalledTimes(1);
		expect(g.running).toBe(false);
	});

	it('picks backup polling up when the enabled flag arrives after the state', () => {
		const fn = vi.fn();
		const g = new IntervalGate(fn, 5000);
		g.set(shouldPollBackup('record', 'recording', false));
		expect(fn).not.toHaveBeenCalled();
		g.set(shouldPollBackup('record', 'recording', true));
		expect(fn).toHaveBeenCalledTimes(1);
		g.stop();
	});

	it('stop() on unmount does not run the follow-up', () => {
		const done = vi.fn();
		const g = new IntervalGate(() => {}, 1000, done);
		g.set(true); g.stop();
		expect(done).not.toHaveBeenCalled();
		expect(g.running).toBe(false);
	});
});

describe('syncDiskGate: the disk alarm\'s first check', () => {
	it('(old behaviour) a bare set(true) on an already-running gate does not check again', () => {
		const fn = vi.fn();
		const g = new IntervalGate(fn, 30_000);
		g.set(true); g.set(true);
		expect(fn).toHaveBeenCalledTimes(1);
		g.stop();
	});

	it('checks at once on idle -> recording although the idle checklist poll already runs the gate', () => {
		const fn = vi.fn();
		const g = new IntervalGate(fn, 30_000);
		syncDiskGate(g, 'record', 'idle');                       // mount: checklist poll starts the gate
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10_000);
		syncDiskGate(g, 'record', 'recording', { mode: 'record', state: 'idle' });
		expect(fn).toHaveBeenCalledTimes(2);                      // not up to 30 s late
		vi.advanceTimersByTime(29_000);
		expect(fn).toHaveBeenCalledTimes(2);                      // interval restarted from the poke
		vi.advanceTimersByTime(1_000);
		expect(fn).toHaveBeenCalledTimes(3);
		g.stop();
	});

	it('does not double-check on a remount that is already recording, or when the gate was off', () => {
		const fn = vi.fn();
		const g = new IntervalGate(fn, 30_000);
		syncDiskGate(g, 'record', 'recording');                   // immediate watcher run, no prev
		expect(fn).toHaveBeenCalledTimes(1);
		g.stop();
		const h = vi.fn();
		const g2 = new IntervalGate(h, 30_000);
		syncDiskGate(g2, 'record', 'recording', { mode: 'playback', state: 'recording' });
		expect(h).toHaveBeenCalledTimes(1);
		g2.stop();
	});

	it('stops the gate when recording ends into finalizing', () => {
		const fn = vi.fn();
		const g = new IntervalGate(fn, 30_000);
		syncDiskGate(g, 'record', 'recording');
		syncDiskGate(g, 'record', 'finalizing', { mode: 'record', state: 'recording' });
		expect(g.running).toBe(false);
	});
});
