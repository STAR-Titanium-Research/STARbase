// Turning recording failures into something an operator can act on (#84).
//
// Two separate paths reach the UI:
//   - /record/start refuses up front. For a setting the hardware can't do it answers 400 with a
//     structured detail ({field, max, min, message}), so the form can point at the field itself.
//   - The session fails after it started. The backend says which stage failed (`error_kind`):
//     "start" (no sample was ever captured, so nothing was kept), "acquisition" (failed mid-run,
//     what was captured was finalized) or "finalize" (the outputs couldn't be written, the raw is
//     still on disk for recovery). The raw driver text is kept for a "Details" disclosure but is
//     never the headline: "DaqError: … DAQmx_SampClk_Rate … Status Code: -200077" says nothing
//     to someone who just wants to record.

/** Which data-focus id (see ui/spotlight.ts) shows a RecordConfig field on the Record page. */
export const FIELD_FOCUS: Record<string, string> = {
	sample_rate: 'sample-rate',
};

export interface StartErrorDetail {
	field?: string;
	max?: number | null;
	min?: number | null;
	message: string;
}

/** A /record/start refusal, carrying the backend's structured detail when there is one. */
export class StartRequestError extends Error {
	constructor(readonly status: number, readonly detail: StartErrorDetail) {
		super(detail.message);
		this.name = 'StartRequestError';
	}
}

/** Build the error for a non-OK /record/start response from its status and body text. */
export function parseStartError(status: number, body: string): StartRequestError {
	let detail: unknown = null;
	try { detail = JSON.parse(body)?.detail; } catch { /* not JSON — use the text */ }
	if (detail && typeof detail === 'object' && typeof (detail as any).message === 'string') {
		return new StartRequestError(status, detail as StartErrorDetail);
	}
	const text = typeof detail === 'string' ? detail : body.slice(0, 200);
	return new StartRequestError(status, { message: `start failed: ${status} ${text}`.trim() });
}

const hz = (v: number) => `${Math.floor(v).toLocaleString()} Hz`;

/** Why the configured rate can't be started on this hardware, or null when it can (or when there
 *  is no known limit — simulated hardware, no DAQmx runtime). */
export function sampleRateIssue(rate: number, max: number | null | undefined, min?: number | null): string | null {
	if (!Number.isFinite(rate) || rate <= 0) return 'Sample rate must be a positive number.';
	if (max != null && rate > max) return `Sample rate ${hz(rate)} is above this hardware's ${hz(max)} maximum.`;
	if (min != null && rate < min) return `Sample rate ${hz(rate)} is below this hardware's ${hz(min)} minimum.`;
	return null;
}

export interface FailureDescription {
	title: string;
	/** Plain-language summary — what happened and what to do. */
	summary: string;
	/** The raw backend/driver text, for a Details disclosure. Empty when there is none. */
	details: string;
	/** A RecordConfig field to point at, when the failure is about one. */
	field?: string;
	/** Whether a raw capture was kept on disk (shown as recoverable). */
	rawKept: boolean;
}

// DAQmx -200077 = a property value out of range; with SampClk.Rate in the text it is the rate.
const RATE_ERROR = /-200077|SampClk[._]?Rate|sample clock rate/i;
const MAX_VALUE = /Maximum Value:\s*([0-9.]+(?:e[+-]?\d+)?)/i;

/** Describe a session that ended in state "error". `kind` is the backend's error_kind (absent on
 *  older backends, in which case a 0-sample failure is still treated as a failed start). */
export function describeRecordingFailure(error: string | null, kind: string | null | undefined, nTotal = 0): FailureDescription {
	const details = (error || '').trim();
	const k = kind || (nTotal > 0 ? 'finalize' : 'start');
	if (k === 'start') {
		if (RATE_ERROR.test(details)) {
			const max = MAX_VALUE.exec(details);
			return {
				title: "Recording couldn't start",
				summary: `The NI-DAQ hardware rejected the sample rate${max ? ` — its maximum here is ${hz(Number(max[1]))}` : ''}. Lower the sample rate and start again. Nothing was recorded or saved.`,
				details, field: 'sample_rate', rawKept: false,
			};
		}
		const first = details.split('\n')[0].replace(/^(could not start acquisition|acquisition error):\s*/i, '');
		return {
			title: "Recording couldn't start",
			summary: `No data was captured, so nothing was saved.${first ? ` The acquisition source reported: ${first.slice(0, 160)}` : ''}`,
			details, rawKept: false,
		};
	}
	if (k === 'acquisition') {
		return {
			title: 'Recording stopped with an error',
			summary: 'Acquisition failed part-way through. What was captured was kept — if it is not listed as a finished recording, recover it from Settings > Local Captures.',
			details, rawKept: true,
		};
	}
	return {
		title: 'Finalizing failed',
		summary: 'Writing this recording\'s files failed. The raw capture is still on disk and can be recovered from Settings > Local Captures — nothing was uploaded.',
		details, rawKept: true,
	};
}
