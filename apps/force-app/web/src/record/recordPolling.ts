// When the Record page polls the recorder for disk space and backup progress. Pulled out of
// RecordPage.vue so the rules can be tested; the page drives it from a watcher that runs
// immediately (review 2.6: the intervals used to start only on a state *change*, so a page
// mounted mid-cut, or a cut adopted by the reconcile on entry, never polled and the disk alarm and
// the chips went stale).

/** Mode 'record' only: play() also marks the status 'recording' (playback/engine.ts), and polling
 * a recorder that writes nothing for an archived cut would be pure noise. */
export function shouldPollDisk(mode: 'record' | 'playback', state: string): boolean {
	return mode === 'record' && state === 'recording';
}

/** The pre-Start checklist (preflight.ts) reads free space and the amp/channel state while the
 * page is waiting to Start, i.e. in record mode and not mid-cut. The disk poll above is reused for
 * the free-space half, so a cut that is on screen (done/error) or about to start is covered too. */
export function shouldPollPreflight(mode: 'record' | 'playback', state: string): boolean {
	return mode === 'record' && state !== 'recording' && state !== 'finalizing';
}

/** Backup progress is only worth polling when a backup is configured. `enabled` arrives with the
 * first /backup/status reply, which on a remount is after the state is already 'recording', so
 * it is an input here and the watcher re-runs when it flips. */
export function shouldPollBackup(mode: 'record' | 'playback', state: string, backupEnabled: boolean): boolean {
	return shouldPollDisk(mode, state) && backupEnabled;
}

/** A repeating call that is on or off. Turning it on runs it once straight away. */
export class IntervalGate {
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor(private fn: () => void, private ms: number, private onStop?: () => void) {}
	get running(): boolean { return this.timer !== null; }
	set(active: boolean): void {
		if (active && !this.timer) {
			this.fn();
			this.timer = setInterval(this.fn, this.ms);
		} else if (!active && this.timer) {
			this.stop();
			this.onStop?.();
		}
	}
	/** Run the call now and restart the interval from here. set(true) is a no-op while running, so
	 *  this is how a gate that was already on (widened to more states) gets an immediate check. */
	poke(): void {
		this.fn();
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(this.fn, this.ms);
	}
	/** Stop without the onStop follow-up (unmount). */
	stop(): void {
		if (this.timer) { clearInterval(this.timer); this.timer = null; }
	}
}

/** Drive the disk gate for a (mode, state) change. The gate also runs while idle (the checklist's
 * free-space runway), so going idle -> recording finds it already running and set(true) would do
 * nothing: the alarm's first check would wait up to a full interval. Poke it on that transition. */
export function syncDiskGate(
	gate: Pick<IntervalGate, 'running' | 'set' | 'poke'>,
	mode: 'record' | 'playback', state: string,
	prev?: { mode: 'record' | 'playback'; state: string },
): void {
	const wasRunning = gate.running;
	const recording = shouldPollDisk(mode, state);
	gate.set(recording || shouldPollPreflight(mode, state));
	if (wasRunning && recording && prev && !shouldPollDisk(prev.mode, prev.state)) gate.poke();
}
