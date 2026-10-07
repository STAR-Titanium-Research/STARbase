// When the Record page opens the Save dialog on its own (stop() opens it itself for a manual stop).
//  - recording -> finalizing/done/error: the cut ended by itself (auto-stop, disk full) or the
//    operator's stop reached us through the stream.
//  - anything -> finalizing: a reconcile adopted a cut that is already being saved (page reload,
//    reconnect) onto an idle client via reset(), so `prev` is never 'recording'. Without this the
//    operator was never offered Save for it.
// finalizing -> done/error does not reopen: the dialog was offered at the start of the finalize,
// and an operator who dismissed it meanwhile must not have it come back.
import type { LiveStatus } from './liveClient';

export function shouldOpenSaveDialog(s: LiveStatus['state'], prev: LiveStatus['state'] | undefined): boolean {
	if (s === 'finalizing') return prev !== 'finalizing';
	return (s === 'done' || s === 'error') && prev === 'recording';
}
