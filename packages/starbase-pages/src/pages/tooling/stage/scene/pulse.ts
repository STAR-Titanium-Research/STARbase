// The halo on the next fresh edge pulses for a short, bounded time after something changes (a focus, a new
// model, a new next-fresh edge) and then rests at full strength, so the stage has no render loop at rest.

export const PULSE_CYCLE_MS = 800;
export const PULSE_CYCLES = 3;
export const PULSE_DURATION_MS = PULSE_CYCLE_MS * PULSE_CYCLES;

/** Whether a pulse started at `start` (ms, the frame clock; null = none) is still running at `now`. */
export function pulseRunning(start: number | null, now: number): boolean {
	return start !== null && now - start < PULSE_DURATION_MS;
}

/** The halo's brightness 0..1: full strength at the start and end of the pulse, and whenever it is not running. */
export function pulseLevel(start: number | null, now: number): number {
	if (start === null || !pulseRunning(start, now)) return 1;
	const t = Math.max(0, now - start);
	return 0.5 + 0.5 * Math.cos((2 * Math.PI * t) / PULSE_CYCLE_MS);
}
