// Which plot ForcePanel's Time view shows, and whether the window slider means anything (#189).
// After a cut the whole recorded trace (FinishedForcePlot) replaces the rolling last-N-seconds
// view (LiveForcePlot). That choice used to include "save dialog closed", so opening or closing
// the dialog flipped the panel between the whole cut and the last N seconds, and the window
// slider stayed on screen although the finished plot ignores it.

export interface ForcePlotViewInput {
	/** The panel's plot mode; only 'time' has a finished-trace view. */
	mode: string;
	/** The cut has ended (state 'done'). */
	isDone: boolean;
	/** The finished live-cache has been loaded. */
	hasCache: boolean;
}

/** 'finished' once the cut is done and its cache is loaded, whatever the save dialog is doing. */
export function forcePlotView(i: ForcePlotViewInput): 'finished' | 'live' {
	return i.mode === 'time' && i.isDone && i.hasCache ? 'finished' : 'live';
}

/** The window-duration control: only for modes with a time axis, and not over the finished plot (always 'time'). */
export function showWindowControl(mode: string, view: 'finished' | 'live'): boolean {
	return mode !== 'fft' && mode !== 'psd' && view !== 'finished';
}
