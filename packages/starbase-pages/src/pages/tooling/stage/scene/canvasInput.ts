// The pointer wiring of the stage's canvas: a click (not a drag) picks, a hover is queued for the next frame,
// leaving the canvas clears the hover, and a lost WebGL context is reported. Plain DOM, no three.js, so the
// scene class stays about drawing. `wireCanvasInput` returns the function that removes every listener.

const CLICK_SLOP_PX = 4;

export interface CanvasInputHandlers {
	/** A primary-button click that was not a drag: pick at these client coordinates. */
	click(clientX: number, clientY: number): void;
	/** The pointer moved over the canvas with no button down: queue a hover pick at these client coordinates. */
	hover(clientX: number, clientY: number): void;
	/** The pointer left the canvas. */
	leave(): void;
	/** The WebGL context was lost. */
	contextLost(): void;
}

export function wireCanvasInput(canvas: HTMLCanvasElement, h: CanvasInputHandlers): () => void {
	let down: { x: number; y: number; id: number } | null = null;
	const cleanups: Array<() => void> = [];
	const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void): void => {
		canvas.addEventListener(type, fn as EventListener);
		cleanups.push(() => canvas.removeEventListener(type, fn as EventListener));
	};

	on('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, id: e.pointerId }; });
	on('pointerup', (e) => {
		const d = down;
		down = null;
		if (!d || d.id !== e.pointerId || e.button !== 0) return;
		if (Math.hypot(e.clientX - d.x, e.clientY - d.y) >= CLICK_SLOP_PX) return; // a drag, not a pick
		h.click(e.clientX, e.clientY);
	});
	on('pointercancel', () => { down = null; });
	on('pointermove', (e) => {
		if (e.buttons !== 0) return; // dragging: the orbit owns it
		h.hover(e.clientX, e.clientY);
	});
	on('pointerleave', () => h.leave());
	const onLost = (e: Event) => { e.preventDefault(); h.contextLost(); };
	canvas.addEventListener('webglcontextlost', onLost);
	cleanups.push(() => canvas.removeEventListener('webglcontextlost', onLost));

	return () => { for (const c of cleanups) c(); cleanups.length = 0; };
}
