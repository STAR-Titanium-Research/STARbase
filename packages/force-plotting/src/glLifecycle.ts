// Keep-alive lifecycle for a component that owns a WebGL context (FrmCloud, FrmOctree).
//
// ForceDashboard's Plot route is kept alive (#24/#57): leaving /plot fires onDeactivated, NOT
// onBeforeUnmount, on every nested component. A viewer that only cleaned up on unmount would keep
// its render loop, GPU buffers and context alive for the rest of the session. So deactivate tears
// down like an unmount, and activate starts again on a FRESH canvas: teardown force-loses the GL
// context (to release it), and getContext() on the same canvas never hands a lost context back, so
// a new renderer there would report "WebGL unavailable".
//
// Only the GL side is suspended. The host's non-GL state (ForceDashboard's bake / octree polls and
// their detail updates) keeps running across a deactivation; whatever it needs a GL viewer for is
// deferred to activation (opGuard.ts createActivationQueue), and a viewer's own load requests are
// ignored while `suspended` and replayed by start().
//
//   teardown()    release everything GPU-side and stop every loop/timer/in-flight load
//   replaceCanvas() give the template a new <canvas> (bump its :key)
//   start()       set up the renderer and (re)load; called after the new canvas is in the DOM
export interface GlLifecycleHooks {
	teardown(): void;
	replaceCanvas(): void;
	start(): void;
}

export interface GlLifecycle {
	/** True between deactivate() and activate(): setup/load requests arriving now must be ignored. */
	readonly suspended: boolean;
	deactivate(): void;
	/** Returns true when it restarted (it was suspended); a plain first-mount activation returns false. */
	activate(): boolean;
	unmount(): void;
}

export function createGlLifecycle(hooks: GlLifecycleHooks): GlLifecycle {
	let suspended = false;
	return {
		get suspended() { return suspended; },
		deactivate() {
			if (suspended) return;
			suspended = true;
			hooks.teardown();
		},
		activate() {
			if (!suspended) return false;
			suspended = false;
			hooks.replaceCanvas();
			hooks.start();
			return true;
		},
		unmount() {
			suspended = false;
			hooks.teardown();
		},
	};
}
