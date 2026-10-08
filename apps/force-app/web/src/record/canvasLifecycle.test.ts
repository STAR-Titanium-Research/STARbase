import { describe, expect, it, vi } from 'vitest';
import { bindCanvasLifecycle, type LifecycleEnv } from './canvasLifecycle';

type Canvas = EventTarget & Element;

// Node's EventTarget stands in for the canvas, document and window (no DOM in this environment).
function rig(withCanvas = true) {
	const canvas = withCanvas ? (new EventTarget() as Canvas) : null;
	const win = new EventTarget();
	const doc = Object.assign(new EventTarget(), { hidden: true });
	const resize = vi.fn(), repaint = vi.fn(), unobserve = vi.fn();
	let observed: (() => void) | null = null;
	const env: LifecycleEnv = { win, doc, observe: (_el, fn) => { observed = fn; return unobserve; } };
	const off = bindCanvasLifecycle(canvas, { resize, repaint }, env);
	return { canvas, doc, win, resize, repaint, unobserve, off, fireObserver: () => observed?.() };
}

describe('bindCanvasLifecycle (#189)', () => {
	it('fully resizes on element resize, window resize and context restore', () => {
		const r = rig();
		r.fireObserver();
		r.win.dispatchEvent(new Event('resize'));
		r.canvas!.dispatchEvent(new Event('contextrestored'));
		expect(r.resize).toHaveBeenCalledTimes(3);
		expect(r.repaint).not.toHaveBeenCalled();
	});
	it('cancels contextlost so the browser may restore it', () => {
		const r = rig();
		const ev = new Event('contextlost', { cancelable: true });
		r.canvas!.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(r.resize).not.toHaveBeenCalled();
		expect(r.repaint).not.toHaveBeenCalled();
	});
	it('only repaints, never resizes, when the document becomes visible; nothing when it hides', () => {
		const r = rig();
		r.doc.dispatchEvent(new Event('visibilitychange'));
		expect(r.repaint).not.toHaveBeenCalled();
		r.doc.hidden = false;
		r.doc.dispatchEvent(new Event('visibilitychange'));
		expect(r.repaint).toHaveBeenCalledTimes(1);
		expect(r.resize).not.toHaveBeenCalled();
	});
	it('only repaints when the window regains focus', () => {
		const r = rig();
		r.win.dispatchEvent(new Event('focus'));
		expect(r.repaint).toHaveBeenCalledTimes(1);
		expect(r.resize).not.toHaveBeenCalled();
	});
	it('removes every listener and the observer on cleanup', () => {
		const r = rig();
		r.off();
		r.canvas!.dispatchEvent(new Event('contextrestored'));
		r.win.dispatchEvent(new Event('resize'));
		r.doc.hidden = false;
		r.doc.dispatchEvent(new Event('visibilitychange'));
		r.win.dispatchEvent(new Event('focus'));
		expect(r.resize).not.toHaveBeenCalled();
		expect(r.repaint).not.toHaveBeenCalled();
		expect(r.unobserve).toHaveBeenCalledTimes(1);
	});
	it('still wires the window and document when there is no canvas yet', () => {
		const r = rig(false);
		r.win.dispatchEvent(new Event('focus'));
		expect(r.repaint).toHaveBeenCalledTimes(1);
	});
});
