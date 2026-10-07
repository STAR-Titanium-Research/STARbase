// "Restart recorder" in the Connectivity Doctor (R11). Only the Electron shell can respawn the
// backend, so the button exists only when `window.forceApp` does; browser and dev builds keep the
// "run uvicorn yourself" instructions.

type Bridge = Pick<NonNullable<Window['forceApp']>, 'restartRecorder'>;

/** The shell's bridge when it can restart the recorder, else undefined (browser / dev build). */
export function restartBridge(w: { forceApp?: Partial<Bridge> } | undefined = typeof window === 'undefined' ? undefined : window): Bridge | undefined {
	const b = w?.forceApp;
	return b && typeof b.restartRecorder === 'function' ? (b as Bridge) : undefined;
}

export interface RestartOutcome {
	ok: boolean;
	/** Why it did not happen, in words for the operator. */
	message: string;
}

/** Runs the restart and turns every way it can fail into a message. Never throws. */
export async function runRestart(bridge: Bridge): Promise<RestartOutcome> {
	try {
		const r = await bridge.restartRecorder();
		if (r.ok) return { ok: true, message: '' };
		return { ok: false, message: r.reason || 'The recorder did not restart.' };
	} catch (e: unknown) {
		return { ok: false, message: e instanceof Error ? e.message : 'The recorder did not restart.' };
	}
}
