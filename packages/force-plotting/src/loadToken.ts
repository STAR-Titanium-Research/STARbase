// Sequence guard for an async load that can be started again before the last one finishes.
// FrmCloud / FrmOctree now stay mounted while the Plot page switches operations, so their load()
// watchers fire with an earlier load still in flight; without a guard the slow, OLDER load lands
// last and shows its cloud (and emits its crop) under the newer op (#94 review).
//
//   const mine = token.next();
//   await somethingSlow();
//   if (!token.isCurrent(mine)) return;   // superseded: emit nothing, touch no state
export interface LoadToken {
	/** Start a new load; every earlier one becomes stale. */
	next(): number;
	isCurrent(n: number): boolean;
	/** Make every in-flight load stale (unmount, or another source took over). */
	cancel(): void;
}

export function createLoadToken(): LoadToken {
	let seq = 0;
	return {
		next: () => ++seq,
		isCurrent: (n) => n === seq,
		cancel: () => { seq++; },
	};
}
