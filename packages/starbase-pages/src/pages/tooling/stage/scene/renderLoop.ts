// The on-demand render loop of the stage. A frame is scheduled only when something changed (`request`), while the
// camera or a lift is still moving, or while the next-fresh halo pulses (a bounded time, see pulse.ts); nothing
// runs at rest. The scene supplies what a frame does through `LoopHost`; this class owns the timing.

import { pulseLevel, pulseRunning } from './pulse';

const PULSE_FRAME_MS = 33; // the pulse draws at about 30 fps

export interface LoopHost {
	/** False when there is nothing to draw yet (no box view) or the scene is gone: the frame does nothing. */
	ready(): boolean;
	/** Whether a halo pulse may run now (a next fresh edge exists, the stage is on screen, motion is allowed ...). */
	pulseAllowed(): boolean;
	/**
	 * Advance everything that moves on its own (queued hover pick, camera ease, orbit damping). Returns true while
	 * something is still moving. Anything that changed the picture calls `loop.request()`, which folds into this frame.
	 */
	advance(now: number): boolean;
	/** Draw one frame; `pulse` is the halo's brightness 0..1. */
	draw(pulse: number): void;
}

export class RenderLoop {
	private raf = 0;
	private dirty = false;
	private inFrame = false;
	private disposed = false;
	private lastDraw = 0;
	private pulseStart: number | null = null;
	private pulseDrawn = false;

	constructor(private readonly host: LoopHost) {}

	/** Something changed: draw a frame soon. Calls made while a frame runs fold into that frame. */
	request(): void {
		this.dirty = true;
		if (!this.inFrame) this.schedule();
	}

	schedule(): void {
		if (this.raf || this.disposed) return;
		this.raf = requestAnimationFrame(this.frame);
	}

	/** A focus, model or next-fresh change: pulse the halo for its bounded time. */
	restartPulse(): void {
		this.pulseStart = performance.now();
	}

	dispose(): void {
		this.disposed = true;
		if (this.raf) cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	private pulsing(now: number): boolean {
		return this.host.pulseAllowed() && pulseRunning(this.pulseStart, now);
	}

	private readonly frame = (now: number): void => {
		this.raf = 0;
		if (this.disposed || !this.host.ready()) return;
		this.inFrame = true;
		let again = false;
		try {
			const busy = this.host.advance(now);
			const pulse = this.pulsing(now);
			if (this.pulseDrawn && !pulse) this.dirty = true; // the pulse just ended: one static frame at full strength
			this.pulseDrawn = pulse;
			again = busy || pulse;
			if (!this.dirty && !busy && !pulse) return; // nothing changed
			if (pulse && !busy && !this.dirty && now - this.lastDraw < PULSE_FRAME_MS) return;
			this.dirty = false;
			this.lastDraw = now;
			this.host.draw(pulse ? pulseLevel(this.pulseStart, now) : 1);
		} finally {
			this.inFrame = false;
			if (again) this.schedule();
		}
	};
}
