// Lets a plot skip drawing while something covers it, then draw once when it is uncovered (#189).
// FinishedForcePlot stays mounted under the Save dialog, which builds its own full-cache plot at the
// same moment: without this both built a full layer at once, one of them behind a modal.

export interface DrawGate {
	/** True when a draw must be skipped right now; remembers that one was wanted. */
	blocked(): boolean;
	/** True once, if a draw was skipped since the last call, and only while no longer paused. */
	takeDirty(): boolean;
}

export function createDrawGate(isPaused: () => boolean): DrawGate {
	let dirty = false;
	return {
		blocked() {
			if (!isPaused()) return false;
			dirty = true;
			return true;
		},
		takeDirty() {
			if (isPaused() || !dirty) return false;
			dirty = false;
			return true;
		},
	};
}
