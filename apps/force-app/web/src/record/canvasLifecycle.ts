import { onBeforeUnmount, onMounted, type Ref } from 'vue';

// Everything a plot canvas needs to stay correct after the window changes under it. A canvas
// Chromium discards while its window is hidden or minimised comes back blank (#189), and the plots
// skip redraws whose data has not changed, so one that was never told stayed blank.

interface Hub {
	addEventListener(type: string, fn: (e: Event) => void): void;
	removeEventListener(type: string, fn: (e: Event) => void): void;
}
export interface LifecycleEnv {
	win: Hub;
	doc: Hub & { hidden?: boolean };
	observe: (el: Element, fn: () => void) => () => void;
}
export interface CanvasLifecycle {
	/** Re-size the canvas (resets the transform a restored 2D context has lost) and drop cached layers. */
	resize: () => void;
	/** Cheap redraw from what is already cached; used when the canvas may have been blanked but not resized. */
	repaint: () => void;
}

const browserEnv = (): LifecycleEnv => ({
	win: window,
	doc: document,
	observe(el, fn) { const ro = new ResizeObserver(fn); ro.observe(el); return () => ro.disconnect(); },
});

/**
 * Wire `canvas` to `resize` (element/window resize, `contextrestored`) and `repaint` (document
 * becoming visible, window focus). `contextlost` is cancelled so the browser may restore the
 * context. Returns the function that removes everything.
 */
export function bindCanvasLifecycle(
	canvas: (Element & Hub) | null | undefined,
	{ resize, repaint }: CanvasLifecycle,
	env: LifecycleEnv = browserEnv(),
): () => void {
	const onLost = (e: Event) => e.preventDefault();
	const onVisible = () => { if (!env.doc.hidden) repaint(); };
	const stopObserve = canvas ? env.observe(canvas, resize) : () => {};
	canvas?.addEventListener('contextlost', onLost);
	canvas?.addEventListener('contextrestored', resize);
	env.win.addEventListener('resize', resize);
	env.win.addEventListener('focus', repaint);
	env.doc.addEventListener('visibilitychange', onVisible);
	return () => {
		stopObserve();
		canvas?.removeEventListener('contextlost', onLost);
		canvas?.removeEventListener('contextrestored', resize);
		env.win.removeEventListener('resize', resize);
		env.win.removeEventListener('focus', repaint);
		env.doc.removeEventListener('visibilitychange', onVisible);
	};
}

/** `bindCanvasLifecycle` for a component: bound on mount, released on unmount. */
export function useCanvasLifecycle(canvasEl: Ref<HTMLCanvasElement | null>, handlers: CanvasLifecycle) {
	let stop: (() => void) | null = null;
	onMounted(() => { stop = bindCanvasLifecycle(canvasEl.value, handlers); });
	onBeforeUnmount(() => { stop?.(); stop = null; });
}
