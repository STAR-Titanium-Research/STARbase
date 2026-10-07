import { describe, expect, it } from 'vitest';
import { StartRequestError, describeRecordingFailure, parseStartError, sampleRateIssue } from './recordingErrors';

const DAQ_TEXT = 'could not start acquisition: DaqError: Requested value is not a supported value for this property.\n'
	+ 'Property: DAQmx_SampClk_Rate\nRequested Value: 52.0e3\nMaximum Value: 51.367188e3\nStatus Code: -200077';

describe('parseStartError', () => {
	it('keeps a structured field detail', () => {
		const e = parseStartError(400, JSON.stringify({ detail: { field: 'sample_rate', max: 51367.188, message: 'too fast' } }));
		expect(e).toBeInstanceOf(StartRequestError);
		expect(e.message).toBe('too fast');
		expect(e.detail.field).toBe('sample_rate');
		expect(e.detail.max).toBe(51367.188);
	});

	it('falls back to the string detail or body text', () => {
		expect(parseStartError(409, JSON.stringify({ detail: 'a recording is already in progress' })).message)
			.toBe('start failed: 409 a recording is already in progress');
		expect(parseStartError(500, 'Internal Server Error').message).toBe('start failed: 500 Internal Server Error');
		expect(parseStartError(500, 'x').detail.field).toBeUndefined();
	});
});

describe('sampleRateIssue', () => {
	it('flags rates outside the hardware limits only', () => {
		expect(sampleRateIssue(52000, 51367.188)).toMatch(/above this hardware's 51,367 Hz maximum/);
		expect(sampleRateIssue(500, null, 1000)).toMatch(/below/);
		expect(sampleRateIssue(51000, 51367.188)).toBeNull();
		expect(sampleRateIssue(1e9, null)).toBeNull(); // no known limit (sim / no runtime)
		expect(sampleRateIssue(0, null)).toMatch(/positive/);
	});
});

describe('describeRecordingFailure', () => {
	it('turns a DAQmx rate refusal into a plain message pointing at the field', () => {
		const d = describeRecordingFailure(DAQ_TEXT, 'start');
		expect(d.title).toBe("Recording couldn't start");
		expect(d.summary).toMatch(/maximum here is 51,367 Hz/);
		expect(d.summary).not.toMatch(/-200077|DaqError/);
		expect(d.details).toContain('-200077');
		expect(d.field).toBe('sample_rate');
		expect(d.rawKept).toBe(false);
	});

	it('never claims a 0-sample failure left a recoverable capture', () => {
		const d = describeRecordingFailure('could not start acquisition: device not found', null, 0);
		expect(d.rawKept).toBe(false);
		expect(d.summary).toMatch(/nothing was saved/);
		expect(d.summary).toMatch(/device not found/);
		expect(d.summary).not.toMatch(/recover/i);
	});

	it('keeps the finalize and mid-run wording distinct', () => {
		expect(describeRecordingFailure('finalize error: disk full', 'finalize').summary).toMatch(/can be recovered/);
		expect(describeRecordingFailure('acquisition error: overrun', 'acquisition', 5000).rawKept).toBe(true);
		// First chunk failed to process: rows are on disk even though the live counter is still 0.
		const d = describeRecordingFailure('acquisition error: x', 'acquisition', 0);
		expect(d.rawKept).toBe(true);
		expect(d.summary).not.toMatch(/No data was captured|nothing was saved/);
		// Older backend (no error_kind) with data: the finalize wording.
		expect(describeRecordingFailure('boom', undefined, 10).title).toBe('Finalizing failed');
	});
});
