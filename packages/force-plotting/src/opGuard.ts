// Guard for long-running work (host-build polls, bakes) that was started for ONE operation and
// must not touch state once the user has moved on. A poll can run for 15 minutes; in that time the
// operator can open another op or unmount the dashboard. Without a guard the poll's result is
// written into whichever op is open by then (#review 3.1).
//
// Leaving the page is NOT one of those events. The Plot route is kept alive (#24/#57), so the
// dashboard's state survives deactivation and a bake started before a visit to the Record page
// should be applied when it finishes. Only work that needs the GL canvas waits: see
// createActivationQueue below.
//
//   const live = guard.begin(d.id);
//   await somethingSlow();
//   if (!live()) return;            // op changed, or cancelAll() was called: touch nothing
export interface OpGuard {
	/** Start guarding work for `opId`; the returned function is true while that work is still wanted. */
	begin(opId: string | null | undefined): () => boolean;
	/** Make every guard handed out so far stale (op switched, unmount). */
	cancelAll(): void;
}

export function createOpGuard(currentOpId: () => string | null | undefined): OpGuard {
	let epoch = 0;
	return {
		begin(opId) {
			const mine = epoch;
			return () => mine === epoch && opId != null && currentOpId() === opId;
		},
		cancelAll() { epoch++; },
	};
}

// Work that must not run while the kept-alive page is deactivated (it would mount or load a GL
// viewer, or fill a cache that deactivation just released) but should still happen once the
// operator returns. Guard each queued closure with its own `live()` so one for an op that has since
// been closed is dropped instead of run.
//
//   queue.whenActive(() => { if (live()) chooseMode('full'); });
export interface ActivationQueue {
	readonly active: boolean;
	/** Run `fn` now when active, else when activate() next runs. */
	whenActive(fn: () => void): void;
	deactivate(): void;
	/** Mark active and run everything queued, in order. */
	activate(): void;
	/** Drop everything queued (unmount). */
	clear(): void;
}

export function createActivationQueue(): ActivationQueue {
	let active = true;
	let queue: Array<() => void> = [];
	return {
		get active() { return active; },
		whenActive(fn) { if (active) fn(); else queue.push(fn); },
		deactivate() { active = false; },
		activate() {
			active = true;
			const run = queue; queue = [];
			for (const fn of run) fn();
		},
		clear() { queue = []; },
	};
}
