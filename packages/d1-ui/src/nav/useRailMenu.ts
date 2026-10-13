import { onBeforeUnmount, ref, watch } from 'vue';
import { clickAction } from './railMenu';

// Which rail icon has its hover menu open (one at a time), and where it is anchored. An icon and its
// menu share a wrapper element, so moving the pointer from one to the other never leaves the pair.
// A tap or press outside the open pair closes it (a finger never "leaves").
export function useRailMenu() {
	const openKey = ref<string | null>(null);
	const anchor = ref<DOMRect | null>(null);
	let wrapper: HTMLElement | null = null;

	function open(key: string, el: HTMLElement) {
		wrapper = el;
		anchor.value = el.getBoundingClientRect();
		openKey.value = key;
	}
	function close(key?: string) {
		if (key !== undefined && openKey.value !== key) return;
		openKey.value = null;
		anchor.value = null;
		wrapper = null;
	}

	// The handlers an icon's wrapper takes; one set per key.
	function pairEvents(key: string) {
		return {
			// Only a mouse hovers; a tap also fires pointerenter and pointerleave and must be left to click.
			pointerenter: (e: PointerEvent) => {
				if (e.pointerType === 'mouse') open(key, e.currentTarget as HTMLElement);
			},
			pointerleave: (e: PointerEvent) => {
				if (e.pointerType === 'mouse') close(key);
			},
			// Keyboard focus opens it; focus that came from a mouse or a tap does not (click decides).
			focusin: (e: FocusEvent) => {
				const t = e.target as HTMLElement;
				if (t.matches?.('.icon') && t.matches(':focus-visible')) open(key, e.currentTarget as HTMLElement);
			},
			focusout: (e: FocusEvent) => {
				const next = e.relatedTarget as Node | null;
				if (!next || !(e.currentTarget as HTMLElement).contains(next)) close(key);
			},
		};
	}
	function onIconClick(key: string, e: MouseEvent) {
		const el = (e.currentTarget as HTMLElement).parentElement as HTMLElement;
		const action = clickAction((e as PointerEvent).pointerType ?? '', openKey.value === key);
		if (action === 'open') open(key, el);
		else if (action === 'close') close(key);
	}

	function onDocumentPointerDown(e: PointerEvent) {
		if (wrapper && !wrapper.contains(e.target as Node)) close();
	}
	watch(openKey, (k) => {
		if (k) document.addEventListener('pointerdown', onDocumentPointerDown, true);
		else document.removeEventListener('pointerdown', onDocumentPointerDown, true);
	});
	onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocumentPointerDown, true));

	return { openKey, anchor, close, pairEvents, onIconClick };
}
