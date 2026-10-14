// The Process map's keyboard, focus and touch input (spec D23, D24), as the canvas's event handlers.
// The decisions (what a key or a focus means) are pure functions, tested without a browser; the
// composable only reads the event, asks them, and calls the page's actions.

import type { Ref } from 'vue';
import { openLink } from '@d1/ui';
import { openPath } from './model/recordInfo';
import { cardOf, isKeyboardFocus, keyTarget, mapElement, mapKey, type ElLike } from './keyboard';
import type { MapActions } from './nodes/actions';
import { createLongPress, type createPointerKind } from './useLongPress';
import type { useMapCanvas } from './useMapCanvas';
import type { useProcessMap } from './useProcessMap';

export type KeyDecision = { do: 'none' } | { do: 'clearHover' } | { do: 'select'; id: string } | { do: 'expand'; id: string } | { do: 'open'; id: string };

/**
 * What a keydown on the canvas does, given what has focus (`keyTarget`). Nothing while a field takes
 * the key; Escape clears the hover card; a button or link keeps Enter for itself (it would also fire
 * its own click, so the card must not be selected on top); the rest is `mapKey`.
 */
export function keyDecision(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, t: ReturnType<typeof keyTarget>): KeyDecision {
	if (t.typing) return { do: 'none' };
	if (e.key === 'Escape') return { do: 'clearHover' };
	const { action, id } = mapKey(e, e.key === 'Enter' && t.control ? null : t.id);
	return action === 'none' || !id ? { do: 'none' } : ({ do: action, id } as KeyDecision);
}

/** Which card keyboard focus asks the map to bring into view: the card holding the focused thing (a slot's owner), none for a pointer's focus. */
export function focusReveal(target: unknown, keyboard = isKeyboardFocus(target)): string | null {
	return keyboard ? (cardOf(target)?.id ?? null) : null;
}

/** The elements a browser scrolls when focus lands on a clipped card: Vue Flow's own containers, nothing above them. */
export const SCROLL_CLIPS = '.vue-flow, .vue-flow__viewport, .vue-flow__renderer, .vue-flow__pane';
export const resetsScroll = (el: ElLike): boolean => !!(el as { matches?(sel: string): boolean }).matches?.(SCROLL_CLIPS);

type ProcessMap = ReturnType<typeof useProcessMap>;
type Canvas = ReturnType<typeof useMapCanvas>;

export function useMapInput(o: {
	map: ProcessMap;
	canvas: Canvas;
	canvasEl: Ref<HTMLElement | null>;
	actions: MapActions;
	router: { push(to: string): unknown };
	pointerKind: ReturnType<typeof createPointerKind>;
}) {
	const { map, canvas, canvasEl, actions, router, pointerKind } = o;

	function onKey(e: KeyboardEvent) {
		pointerKind.keyboard();
		const d = keyDecision(e, keyTarget(e.target));
		if (d.do === 'none' || d.do === 'clearHover') {
			if (d.do === 'clearHover') map.clearHover();
			return;
		}
		e.preventDefault();
		if (d.do === 'select') actions.select(d.id);
		else if (d.do === 'expand') actions.expand(d.id);
		else {
			// The same address as the rail's Open record; a junction or the "+N more" stub has no record.
			const info = map.info(d.id);
			const to = info ? openPath(info) : null;
			if (to) openLink(to, router);
		}
	}

	/** Keyboard focus on an off-screen card pans to it; the browser would scroll the clipped canvas instead. */
	function onFocusIn(e: FocusEvent) {
		const id = focusReveal(e.target);
		if (!id) return;
		for (let el = e.target as HTMLElement | null; el; el = el.parentElement) {
			if (resetsScroll(el)) {
				el.scrollLeft = 0;
				el.scrollTop = 0;
			}
			if (el === canvasEl.value) break;
		}
		canvas.reveal(id);
	}

	const longPress = createLongPress<{ id: string; el: HTMLElement }>(({ id, el }) => map.holdHover(id, el));

	function onPointerDown(e: PointerEvent) {
		pointerKind.note(e.pointerType);
		if (e.pointerType !== 'touch') {
			longPress.consumeFired(); // a long press whose click never came must not swallow a mouse click later
			return;
		}
		map.clearHover(); // a card from the last long press goes with the next touch
		const found = e.isPrimary ? mapElement(e.target) : null; // a second finger is a pinch
		if (found) longPress.start(e.clientX, e.clientY, { id: found.id, el: found.el as HTMLElement });
		else longPress.cancel();
	}
	function onPointerMove(e: PointerEvent) {
		pointerKind.note(e.pointerType);
		if (e.pointerType === 'touch') longPress.move(e.clientX, e.clientY);
	}
	/** The tap that ends a long press is not a tap: it must not also select. */
	function onClickCapture(e: MouseEvent) {
		if (!longPress.consumeFired()) return;
		e.stopPropagation();
		e.preventDefault();
	}
	const onPointerEnd = () => longPress.cancel();
	const onContextMenu = (e: Event) => {
		if (pointerKind.touch) e.preventDefault();
	};

	return { onKey, onFocusIn, onPointerDown, onPointerMove, onPointerEnd, onClickCapture, onContextMenu };
}
