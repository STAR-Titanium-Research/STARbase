import { describe, expect, it } from 'vitest';
import { STAT_ORDER } from './crawlerModel';
import { daemonFacts, daemonView, filesText, queueRow, statTiles, toggleLabel, toneWorthShowing } from './crawlerView';

describe('statTiles', () => {
	it('is one tile per state in order, with the shared force words and tones', () => {
		const tiles = statTiles(STAT_ORDER, { pending: 3, done: 10, error: 2 });
		expect(tiles.map((t) => t.key)).toEqual([...STAT_ORDER]);
		expect(tiles.map((t) => t.label)).toEqual(['Queued', 'Processing', 'Analysed', 'Error', 'Skipped']);
		expect(tiles.map((t) => t.tone)).toEqual(['info', 'progress', 'success', 'danger', 'neutral']);
		expect(tiles.map((t) => t.value)).toEqual([3, 0, 10, 2, 0]);
	});
	it('falls back for a state outside the vocabulary', () => {
		const [t] = statTiles(['weird_state'], {});
		expect(t).toMatchObject({ label: 'Weird state', tone: 'neutral', value: 0, icon: 'circle' });
	});
	it('colours only a non-empty error or processing figure', () => {
		const [pending, processing, , error] = statTiles(STAT_ORDER, { pending: 5, processing: 1, error: 0 });
		expect(toneWorthShowing(pending!)).toBe(false);
		expect(toneWorthShowing(processing!)).toBe(true);
		expect(toneWorthShowing(error!)).toBe(false);
	});
});

describe('daemonView / toggleLabel', () => {
	it('is danger when offline whatever was asked, else success or warning by the desired state', () => {
		expect(daemonView(false, true).tone).toBe('danger');
		expect(daemonView(true, true)).toEqual({ label: 'Online, running', tone: 'success' });
		expect(daemonView(true, false)).toEqual({ label: 'Online, paused', tone: 'warning' });
	});
	it('pauses a running daemon and starts any other', () => {
		expect(toggleLabel(true)).toBe('Pause');
		expect(toggleLabel(false)).toBe('Start');
	});
});

describe('daemonFacts', () => {
	it('reads a missing state as dashes and zero counts', () => {
		const facts = daemonFacts(null);
		expect(facts.find((f) => f.label === 'PID')?.value).toBe('—');
		expect(facts.find((f) => f.label === 'Session done / errors')?.value).toBe('0 / 0');
	});
	it('shows the values of the row', () => {
		const facts = daemonFacts({ desired_state: 'running', daemon_pid: 4242, current_activity: 'file.mat', processed_count: 7, error_count: 1 });
		expect(facts.find((f) => f.label === 'Desired state')?.value).toBe('running');
		expect(facts.find((f) => f.label === 'PID')?.value).toBe('4242');
		expect(facts.find((f) => f.label === 'Activity')).toMatchObject({ value: 'file.mat', mono: true });
		expect(facts.find((f) => f.label === 'Session done / errors')?.value).toBe('7 / 1');
	});
});

describe('queueRow / filesText', () => {
	it('labels the row by its pass code, then sample code, then id', () => {
		expect(queueRow({ id: 'a', status: 'error', error_message: 'boom', operation_id: { pass_code: 'MT-F1' } })).toMatchObject({ label: 'MT-F1', status: 'error', message: 'boom' });
		expect(queueRow({ id: 'b', operation_id: { sample_id: { sample_code: 'S-1' } } })).toMatchObject({ label: 'S-1', message: null });
		expect(queueRow({ id: 'c' }).label).toBe('c');
	});
	it('pluralises', () => {
		expect(filesText(1)).toBe('1 file');
		expect(filesText(2)).toBe('2 files');
	});
});
