// Frame / crop schedulers for FrmCloud, with the timer functions injectable so the state they keep
// can be tested without a DOM. Both hand out a "pending" id that guards re-entry
// (`if (pending) return`), so cancelling one WITHOUT zeroing it blocks every later request: that
// is what broke FrmCloud after a keep-alive deactivate/reactivate (#57, review 3.3).

export interface FrameGate {
	/** Run `cb` on the next frame unless a frame is already queued. */
	request(cb: () => void): void;
	/** Drop the queued frame and zero the pending id, so the next request() schedules again. */
	cancel(): void;
	readonly pending: boolean;
}

export function createFrameGate(
	raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
	caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): FrameGate {
	let id = 0;
	return {
		request(cb) {
			if (id) return;
			id = raf(() => { id = 0; cb(); });
		},
		cancel() { if (id) caf(id); id = 0; },
		get pending() { return id !== 0; },
	};
}

export interface TrailingThrottle {
	/** Run now if idle, else remember to run once more when the window closes. */
	trigger(): void;
	/** Clear the timer and the trailing flag; the next trigger() runs immediately. */
	cancel(): void;
	readonly pending: boolean;
}

export function createTrailingThrottle(
	run: () => void,
	ms: number,
	setT: (cb: () => void, ms: number) => number = (cb, t) => window.setTimeout(cb, t),
	clearT: (id: number) => void = (id) => window.clearTimeout(id),
): TrailingThrottle {
	let timer = 0, trailing = false;
	const step = () => {
		timer = 0;
		if (trailing) { trailing = false; run(); timer = setT(step, ms); }
	};
	return {
		trigger() {
			if (timer) { trailing = true; return; }
			run();
			timer = setT(step, ms);
		},
		cancel() { if (timer) clearT(timer); timer = 0; trailing = false; },
		get pending() { return timer !== 0; },
	};
}
