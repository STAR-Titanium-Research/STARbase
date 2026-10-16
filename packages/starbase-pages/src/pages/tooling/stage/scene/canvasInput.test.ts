import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackPointers, wireCanvasInput } from './canvasInput';

const pointer = (type: string, id: number, extra: Record<string, unknown> = {}) => Object.assign(new Event(type), { pointerId: id, buttons: 0, button: 0, clientX: 0, clientY: 0, pointerType: 'mouse', ...extra });

afterEach(() => vi.useRealTimers());

describe('trackPointers', () => {
	it('counts a pointer from its pointer down, in the capture phase (before another listener on the canvas), until after its up', () => {
		vi.useFakeTimers();
		const canvas = new EventTarget();
		const t = trackPointers(canvas);
		const seen: number[] = [];
		canvas.addEventListener('pointerdown', () => seen.push(t.count())); // the orbit controls: registered after, runs after
		canvas.addEventListener('pointerup', () => seen.push(t.count()));
		expect(t.count()).toBe(0); // a wheel zoom: no pointer, not an orbit
		canvas.dispatchEvent(pointer('pointerdown', 1));
		expect(t.count()).toBe(1);
		canvas.dispatchEvent(pointer('pointerup', 1));
		expect(seen).toEqual([1, 1]); // still counted while the orbit controls handle the up
		expect(t.count()).toBe(1);
		vi.runAllTimers();
		expect(t.count()).toBe(0);
	});

	it('counts a pinch as two, and a cancel like an up, and stops listening when disposed', () => {
		vi.useFakeTimers();
		const canvas = new EventTarget();
		const t = trackPointers(canvas);
		canvas.dispatchEvent(pointer('pointerdown', 1));
		canvas.dispatchEvent(pointer('pointerdown', 2));
		expect(t.count()).toBe(2);
		canvas.dispatchEvent(pointer('pointercancel', 1));
		vi.runAllTimers();
		expect(t.count()).toBe(1);
		t.dispose();
		canvas.dispatchEvent(pointer('pointerdown', 3));
		expect(t.count()).toBe(1);
	});
});

describe('wireCanvasInput: hover', () => {
	const wire = () => {
		const canvas = new EventTarget() as unknown as HTMLCanvasElement;
		const hovers: Array<[number, number]> = [];
		wireCanvasInput(canvas, { click() {}, hover: (x, y) => hovers.push([x, y]), leave() {}, contextLost() {} });
		return { canvas, hovers };
	};

	it('hovers for a mouse, and for a pen, with no button down', () => {
		const { canvas, hovers } = wire();
		canvas.dispatchEvent(pointer('pointermove', 1, { clientX: 5, clientY: 6 }));
		canvas.dispatchEvent(pointer('pointermove', 1, { clientX: 7, clientY: 8, pointerType: 'pen' }));
		expect(hovers).toEqual([[5, 6], [7, 8]]);
	});

	it('does not hover for a finger, nor while a button is down (the orbit owns that)', () => {
		const { canvas, hovers } = wire();
		canvas.dispatchEvent(pointer('pointermove', 1, { pointerType: 'touch' }));
		canvas.dispatchEvent(pointer('pointermove', 1, { buttons: 1 }));
		expect(hovers).toEqual([]);
	});
});
